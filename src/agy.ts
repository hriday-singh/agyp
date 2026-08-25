/**
 * Everything that touches the live `agy` CLI: its single credential entry,
 * whether it is currently running, and launching it.
 *
 * `agy` stores exactly one auth blob, under keyring service `gemini`, account
 * `antigravity`. Nothing else about it is per-account — settings, history,
 * skills, MCP config and trusted workspaces are all shared. Swapping that one
 * entry is therefore the whole of "switching profiles".
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as keyring from './keyring.js';

export const AGY_SERVICE = 'gemini';
export const AGY_ACCOUNT = 'antigravity';

export function liveTokenFilePath(): string {
  const base = process.env.GEMINI_CLI_DATA_DIR || join(homedir(), '.gemini', 'antigravity-cli');
  return join(base, 'antigravity-oauth-token');
}

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
  const raw = readLiveRaw();
  return raw === null ? null : parseBlob(raw);
}

export function readLiveRaw(): string | null {
  try {
    const raw = keyring.get(AGY_SERVICE, AGY_ACCOUNT);
    if (raw) return raw;
  } catch {
    // Keyring unavailable; fallback to file
  }
  const tokenPath = liveTokenFilePath();
  if (existsSync(tokenPath)) {
    try {
      return readFileSync(tokenPath, 'utf8');
    } catch {
      return null;
    }
  }
  return null;
}

export function writeLive(raw: string): void {
  parseBlob(raw); // refuse to install anything agy could not read back
  try {
    keyring.set(AGY_SERVICE, AGY_ACCOUNT, raw);
  } catch {
    // Keyring unavailable; file fallback will be written
  }
  const tokenPath = liveTokenFilePath();
  try {
    mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, raw, { mode: 0o600 });
  } catch {
    // Best-effort file fallback
  }
}

export function clearLive(): void {
  try {
    keyring.del(AGY_SERVICE, AGY_ACCOUNT);
  } catch {
    // Ignore keyring failure
  }
  const tokenPath = liveTokenFilePath();
  if (existsSync(tokenPath)) {
    try {
      rmSync(tokenPath, { force: true });
    } catch {
      // Ignore removal failure
    }
  }
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

/**
 * What a carriage-return-redrawn line actually reads as once it settles: the
 * text after the last `\r`. Empty when the line held nothing but whitespace.
 */
export function finalFrame(raw: string): string {
  const line = (raw.split('\r').pop() ?? '').trimEnd();
  return line.trim() ? line : '';
}

/**
 * Run `agy` with its output captured instead of inherited, so our spinner owns
 * the terminal line while agy's real messages still get through. Async because
 * a spinner cannot tick through `spawnSync`.
 *
 * `onLine` only sees completed lines, and only what survives the last `\r` on
 * one — agy redraws its own spinner in place, so those frames collapse into the
 * final text and never reach the terminal.
 */
export function runAgyQuiet(
  args: string[],
  onLine?: (line: string) => void,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('agy', args, { shell: process.platform === 'win32', windowsHide: true });
    let output = '';
    let buffer = '';

    const emit = (raw: string) => {
      const line = finalFrame(raw);
      if (line) onLine?.(line);
    };
    const collect = (d: Buffer) => {
      output += d.toString();
      buffer += d.toString();
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) emit(part);
    };

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (e) => reject(new Error(`could not launch agy: ${e.message}`)));
    child.on('close', (code) => {
      if (buffer) emit(buffer);
      resolve({ code: code ?? 0, output });
    });
  });
}

/** Run `agy` attached to this terminal. Returns its exit code. */
export function launchAgy(args: string[], env?: NodeJS.ProcessEnv): number {
  const r = spawnSync('agy', args, { stdio: 'inherit', shell: process.platform === 'win32', env });
  if (r.error) throw new Error(`could not launch agy: ${r.error.message}`);
  return r.status ?? 0;
}
