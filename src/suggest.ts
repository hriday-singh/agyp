/**
 * "Did you mean?" suggestions using Levenshtein distance and command alias mappings.
 */

export const COMMAND_ALIASES: Record<string, string> = {
  save: 'adopt',
  capture: 'adopt',
  claim: 'adopt',
  'add-current': 'adopt',

  add: 'login',
  signin: 'login',
  'sign-in': 'login',
  auth: 'login',

  ls: 'list',
  show: 'list',
  all: 'list',

  switch: 'use',
  select: 'use',
  set: 'use',
  checkout: 'use',

  start: 'run',
  exec: 'run',
  launch: 'run',

  quota: 'usage',
  credits: 'usage',
  limits: 'usage',
  'check-quota': 'usage',

  upgrade: 'update',
  'sync-models': 'update',

  info: 'status',
  st: 'status',
  whoami: 'status',
  current: 'status',

  rename: 'label',
  tag: 'label',
  alias: 'label',
  name: 'label',

  rm: 'remove',
  delete: 'remove',
  del: 'remove',
  unlink: 'remove',
  purge: 'remove',

  check: 'doctor',
  health: 'doctor',
  diag: 'doctor',
  diagnose: 'doctor',

  statistics: 'stats',
  metrics: 'stats',
  plan: 'stats',
  plans: 'stats',

  spin: 'spinner',
  loading: 'spinner',


  best: 'auto',
  pick: 'auto',
  'auto-use': 'auto',
  'auto-run': 'autorun',
  'run-auto': 'autorun',
};

export const ALL_COMMAND_NAMES: string[] = [
  'adopt', 'save', 'capture', 'claim', 'add-current',
  'login', 'add', 'signin', 'sign-in', 'auth',
  'list', 'ls', 'show', 'all',
  'use', 'switch', 'select', 'set', 'checkout',
  'run', 'start', 'exec', 'launch',
  'auto', 'best', 'pick', 'auto-use',
  'autorun', 'auto-run', 'run-auto',
  'usage', 'quota', 'credits', 'limits', 'check-quota',
  'update', 'upgrade', 'sync-models',
  'status', 'info', 'st', 'whoami', 'current',
  'label', 'rename', 'tag', 'alias', 'name',
  'remove', 'rm', 'delete', 'del', 'unlink', 'purge',
  'doctor', 'check', 'health', 'diag', 'diagnose',
  'stats', 'statistics', 'metrics', 'plan', 'plans',
  'spinner', 'spin', 'loading',
  'help',
];

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1]?.toLowerCase() === b[j - 1]?.toLowerCase() ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }

  return dp[m]![n]!;
}

export function findBestMatch(input: string, candidates: string[], maxDistance = 3): string | null {
  if (!input || candidates.length === 0) return null;
  const lowerInput = input.toLowerCase();

  let bestCandidate: string | null = null;
  let minDistance = Infinity;

  for (const candidate of candidates) {
    const lowerCandidate = candidate.toLowerCase();
    const dist = levenshtein(lowerInput, lowerCandidate);

    // Limit maximum distance relative to string length to avoid absurd suggestions
    const allowedDist = Math.min(maxDistance, Math.floor(Math.max(lowerInput.length, lowerCandidate.length) / 2));

    if (dist <= allowedDist && dist < minDistance) {
      minDistance = dist;
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

export function formatSuggestion(input: string, bestMatch: string | null, prefix = 'did you mean'): string {
  if (!bestMatch) return '';
  return ` — ${prefix} "${bestMatch}"?`;
}
