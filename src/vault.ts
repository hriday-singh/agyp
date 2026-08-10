/**
 * Profile storage.
 *
 * Two halves, deliberately split:
 *   - secrets  -> OS keyring, service `agy-profiler`, account = the email
 *   - metadata -> ~/.agy-profiler/profiles.json (no secrets, safe to read/back up)
 *
 * The index carries a *fingerprint* of each profile's refresh token so we can
 * answer "which profile is agy currently logged in as?" with a single keyring
 * read instead of decrypting every profile.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as keyring from './keyring.js';

export const VAULT_SERVICE = 'agy-profiler';
/** Holds the outgoing credential while `agyp login` runs, so a crash can't lose it. */
export const PENDING_ACCOUNT = '_pending';

export interface ProfileMeta {
  email: string;
  label?: string;
  /** sha256(refresh_token) truncated — identity check without exposing the token. */
  fingerprint: string;
  /** Cloud Code project, cached so quota lookups skip loadCodeAssist. */
  projectId?: string;
  addedAt: string;
  lastUsed?: string;
}

export interface VaultIndex {
  version: 1;
  /** Email of the profile we last installed into agy's keyring entry. */
  active?: string;
  profiles: ProfileMeta[];
}

export function vaultDir(): string {
  return process.env.AGYP_HOME || join(homedir(), '.agy-profiler');
}

export function indexPath(): string {
  return join(vaultDir(), 'profiles.json');
}

export function fingerprint(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex').slice(0, 16);
}

export function loadIndex(): VaultIndex {
  const path = indexPath();
  if (!existsSync(path)) return { version: 1, profiles: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as VaultIndex;
    if (!Array.isArray(parsed.profiles)) throw new Error('bad shape');
    return { version: 1, active: parsed.active, profiles: parsed.profiles };
  } catch {
    throw new Error(`${path} is corrupt — delete it to start over (secrets live in the keyring, not this file)`);
  }
}

export function saveIndex(index: VaultIndex): void {
  mkdirSync(vaultDir(), { recursive: true, mode: 0o700 });
  writeFileSync(indexPath(), JSON.stringify(index, null, 2) + '\n', { mode: 0o600 });
}

export function getSecret(email: string): string | null {
  return keyring.get(VAULT_SERVICE, email);
}

export function setSecret(email: string, raw: string): void {
  keyring.set(VAULT_SERVICE, email, raw);
}

export function delSecret(email: string): void {
  keyring.del(VAULT_SERVICE, email);
}

/**
 * Resolve a user-supplied target to a profile: exact email, 1-based list index,
 * label, or unambiguous email prefix.
 */
export function resolve(index: VaultIndex, target: string): ProfileMeta {
  const byEmail = index.profiles.find((p) => p.email === target);
  if (byEmail) return byEmail;

  if (/^\d+$/.test(target)) {
    const at = index.profiles[Number(target) - 1];
    if (!at) throw new Error(`no profile #${target} (have ${index.profiles.length})`);
    return at;
  }

  const lower = target.toLowerCase();
  const matches = index.profiles.filter(
    (p) => p.label?.toLowerCase() === lower || p.email.toLowerCase().startsWith(lower),
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`"${target}" matches ${matches.map((m) => m.email).join(', ')} — be more specific`);
  }
  throw new Error(`no profile matching "${target}" — run \`agyp list\``);
}

export function upsert(index: VaultIndex, meta: ProfileMeta): VaultIndex {
  const rest = index.profiles.filter((p) => p.email !== meta.email);
  return { ...index, profiles: [...rest, meta].sort((a, b) => a.email.localeCompare(b.email)) };
}
