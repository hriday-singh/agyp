/**
 * Everything that touches the live `agy` CLI: its single credential entry,
 * whether it is currently running, and launching it.
 *
 * `agy` stores exactly one auth blob, under keyring service `gemini`, account
 * `antigravity`. Nothing else about it is per-account — settings, history,
 * skills, MCP config and trusted workspaces are all shared. Swapping that one
 * entry is therefore the whole of "switching profiles".
 */
import { spawnSync } from 'node:child_process';
import * as keyring from './keyring.js';

export const AGY_SERVICE = 'gemini';
export const AGY_ACCOUNT = 'antigravity';

/** Shape of the blob `agy` writes. `expiry` is RFC3339 with offset. */
export interface AgyBlob {
  token: {
    access_token: string;
    token_type: string;
    refresh_token: string;
    expiry: string;
  };
  auth_method: string;
}

export function parseBlob(raw: string): AgyBlob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('credential blob is not JSON — agy may have changed its storage format');
  }
  if (!isAgyBlob(parsed)) {
    throw new Error('credential blob is missing token.refresh_token — unexpected agy format');
  }
  return parsed;
}

export function isAgyBlob(value: unknown): value is AgyBlob {
  if (typeof value !== 'object' || value === null) return false;
  const token = (value as { token?: unknown }).token;
  if (typeof token !== 'object' || token === null) return false;
  const refresh = (token as { refresh_token?: unknown }).refresh_token;
  return typeof refresh === 'string' && refresh.length > 0;
}

/** Read the credential `agy` is currently authenticated with. */
export function readLive(): AgyBlob | null {
  const raw = keyring.get(AGY_SERVICE, AGY_ACCOUNT);
  return raw === null ? null : parseBlob(raw);
}

export function readLiveRaw(): string | null {
  return keyring.get(AGY_SERVICE, AGY_ACCOUNT);
}

export function writeLive(raw: string): void {
  parseBlob(raw); // refuse to install anything agy could not read back
  keyring.set(AGY_SERVICE, AGY_ACCOUNT, raw);
}

export function clearLive(): void {
  keyring.del(AGY_SERVICE, AGY_ACCOUNT);
}

/**
 * A running `agy` holds its token in memory and rewrites the keyring entry when
 * it refreshes. Swapping underneath it would let the old account's token
 * overwrite the profile we just activated — so callers must refuse to switch
 * while it runs.
 */
export function agyRunning(): boolean {
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq agy.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return r.status === 0 && /agy\.exe/i.test(r.stdout);
  }
  const r = spawnSync('pgrep', ['-x', 'agy'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim().length > 0;
}

export function agyPath(): string | null {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(probe, ['agy'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/)[0]?.trim() || null;
}

/** Installed agy version, e.g. "1.1.11". `agy --version` prints it and exits non-zero. */
export function agyVersion(): string | null {
  const r = spawnSync('agy', ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  const first = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split(/\r?\n/)[0]?.trim() ?? '';
  return /^\d+\.\d+/.test(first) ? first : null;
}

/** Run `agy` attached to this terminal. Returns its exit code. */
export function launchAgy(args: string[], env?: NodeJS.ProcessEnv): number {
  const r = spawnSync('agy', args, { stdio: 'inherit', shell: process.platform === 'win32', env });
  if (r.error) throw new Error(`could not launch agy: ${r.error.message}`);
  return r.status ?? 0;
}
