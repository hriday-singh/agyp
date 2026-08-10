/**
 * Google Cloud Code API — the same endpoints Antigravity itself uses for quota.
 *
 * A profile's refresh token is enough to read that account's quota, so `agyp
 * usage --all` never has to touch the live `agy` credential or switch accounts.
 *
 * The OAuth client below is Antigravity's own public desktop client (a desktop
 * OAuth "secret" is not a secret — it ships in every copy of the app). Override
 * with ANTIGRAVITY_OAUTH_CLIENT_ID / _SECRET if Google ever rotates it.
 */

export const OAUTH = {
  clientId:
    process.env.ANTIGRAVITY_OAUTH_CLIENT_ID ||
    '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
  clientSecret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || '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',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userInfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
};

export const CLOUDCODE = {
  baseUrl: 'https://cloudcode-pa.googleapis.com',
  userAgent: 'antigravity',
  metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
};

export interface ModelQuota {
  label: string;
  /** Every model id that shares this label — they share one quota pool. */
  modelIds: string[];
  /**
   * Fraction of the pool left. Undefined when the API omits it, which it does
   * for pools it has nothing to report on — shown as "n/a" rather than guessed.
   */
  remainingPercentage?: number;
  isExhausted: boolean;
  resetTime?: string;
  timeUntilResetMs?: number;
}

export interface PromptCredits {
  available: number;
  monthly: number;
  remainingPercentage: number;
}

export interface Snapshot {
  email: string;
  planType?: string;
  promptCredits?: PromptCredits;
  models: ModelQuota[];
}

export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch(OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: OAUTH.clientId,
      client_secret: OAUTH.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400 || res.status === 401) {
      throw new Error('refresh token rejected — this profile needs `agyp login` again');
    }
    throw new Error(`token refresh failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('token refresh returned no access_token');
  return json.access_token;
}

export async function fetchEmail(accessToken: string): Promise<string> {
  const res = await fetch(OAUTH.userInfoUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`userinfo failed: ${res.status}`);
  const json = (await res.json()) as { email?: string };
  if (!json.email) throw new Error('userinfo returned no email');
  return json.email;
}

async function cloudCode(path: string, accessToken: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${CLOUDCODE.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': CLOUDCODE.userAgent,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Record<string, unknown>;
}

export function loadCodeAssist(accessToken: string) {
  return cloudCode('/v1internal:loadCodeAssist', accessToken, { metadata: CLOUDCODE.metadata });
}

export function fetchAvailableModels(accessToken: string, projectId?: string) {
  return cloudCode('/v1internal:fetchAvailableModels', accessToken, projectId ? { project: projectId } : {});
}

export function extractProjectId(loadResponse: Record<string, unknown>): string | undefined {
  const value = loadResponse['cloudaicompanionProject'];
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return undefined;
}

/**
 * Internal models (`chat_*`, `tab_*`, `rev*`) and anything without a display
 * name is plumbing the IDE uses, not something you pick in a session.
 */
export function shouldShowModel(modelId: string, model: { quotaInfo?: unknown; displayName?: string }): boolean {
  if (modelId.startsWith('chat_') || modelId.startsWith('tab_') || modelId.startsWith('rev')) return false;
  if (modelId.includes('mquery')) return false;
  return Boolean(model.quotaInfo) && Boolean(model.displayName);
}

interface RawModel {
  displayName?: string;
  label?: string;
  quotaInfo?: { remainingFraction?: number; isExhausted?: boolean; resetTime?: string };
}

export function parseSnapshot(
  loadResponse: Record<string, unknown>,
  modelsResponse: Record<string, unknown>,
  email: string,
  now = Date.now(),
): Snapshot {
  // Several model ids map to one display name and share one quota pool
  // (e.g. gemini-2.5-flash, gemini-3.1-flash-lite -> "Gemini 3.1 Flash Lite").
  // Listing them separately would look like separate budgets.
  const grouped = new Map<string, ModelQuota>();
  const raw = (modelsResponse['models'] ?? {}) as Record<string, RawModel>;

  for (const [modelId, model] of Object.entries(raw)) {
    if (!shouldShowModel(modelId, model)) continue;
    const quota = model.quotaInfo;
    const label = model.displayName || model.label || modelId;
    const existing = grouped.get(label);
    const resetTime = earliest(existing?.resetTime, quota?.resetTime);
    const resetMs = resetTime ? new Date(resetTime).getTime() - now : NaN;

    grouped.set(label, {
      label,
      modelIds: [...(existing?.modelIds ?? []), modelId],
      remainingPercentage: existing?.remainingPercentage ?? quota?.remainingFraction,
      isExhausted: (existing?.isExhausted ?? false) || (quota?.isExhausted ?? quota?.remainingFraction === 0),
      resetTime,
      timeUntilResetMs: Number.isFinite(resetMs) && resetMs > 0 ? resetMs : undefined,
    });
  }

  const models = [...grouped.values()].sort((a, b) => a.label.localeCompare(b.label));

  const planInfo = loadResponse['planInfo'] as { planType?: string; monthlyPromptCredits?: number } | undefined;
  // The subscription lives in `paidTier` ({id: "g1-pro-tier", name: "Google AI
  // Pro"}). `currentTier` is the Code Assist licensing tier and reads
  // {id: "free-tier", name: "Antigravity"} even on a paid account — showing that
  // labels every Pro user as free, so paidTier wins.
  const paidTier = loadResponse['paidTier'] as { id?: string; name?: string } | undefined;
  const currentTier = loadResponse['currentTier'] as { id?: string; name?: string } | undefined;
  const available = loadResponse['availablePromptCredits'] as number | undefined;
  const monthly = planInfo?.monthlyPromptCredits;
  const promptCredits =
    monthly !== undefined && available !== undefined
      ? { available, monthly, remainingPercentage: monthly > 0 ? available / monthly : 0 }
      : undefined;

  return {
    email,
    planType: paidTier?.name ?? planInfo?.planType ?? currentTier?.name ?? currentTier?.id,
    promptCredits,
    models,
  };
}

function earliest(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

/** Refresh token -> full quota snapshot. Returns the project id so callers can cache it. */
export async function fetchQuota(
  refreshToken: string,
  email: string,
  cachedProjectId?: string,
): Promise<{ snapshot: Snapshot; projectId?: string }> {
  const accessToken = await refreshAccessToken(refreshToken);
  const loadResponse = await loadCodeAssist(accessToken);
  const projectId = cachedProjectId ?? extractProjectId(loadResponse);
  const modelsResponse = await fetchAvailableModels(accessToken, projectId);
  return { snapshot: parseSnapshot(loadResponse, modelsResponse, email), projectId };
}
