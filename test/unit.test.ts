import { readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAgyBlob, parseBlob } from '../src/agy.js';
import { chromePath, guestBrowserEnv } from '../src/browser.js';
import { UserError, parseArgs } from '../src/args.js';
import { catalogFromSnapshot, describeDiff, diffCatalog, isEmptyDiff } from '../src/catalog.js';
import { parseSnapshot, shouldShowModel } from '../src/google.js';
import { winTarget } from '../src/keyring.js';
import { bar, humanDuration } from '../src/render.js';
import { fingerprint, resolve, upsert, type VaultIndex } from '../src/vault.js';

describe('parseArgs', () => {
  it('splits command, positional, flags and passthrough', () => {
    const parsed = parseArgs(['run', 'work', '--force', '--', '--model', 'gemini-3.1-pro']);
    expect(parsed.command).toBe('run');
    expect(parsed.positional).toEqual(['work']);
    expect(parsed.flags.has('force')).toBe(true);
    expect(parsed.passthrough).toEqual(['--model', 'gemini-3.1-pro']);
  });

  it('reads --label as a value option, not a flag', () => {
    const parsed = parseArgs(['login', '--label', 'personal']);
    expect(parsed.options.get('label')).toBe('personal');
    expect(parsed.flags.has('label')).toBe(false);
    expect(parsed.positional).toEqual([]);
  });

  it('rejects --label with no value', () => {
    expect(() => parseArgs(['login', '--label'])).toThrow(UserError);
  });

  it('defaults to help', () => {
    expect(parseArgs([]).command).toBe('help');
    expect(parseArgs(['-h']).flags.has('help')).toBe(true);
  });
});

const index: VaultIndex = {
  version: 1,
  profiles: [
    { email: 'alice@gmail.com', label: 'personal', fingerprint: 'aaaa', addedAt: '2026-01-01T00:00:00Z' },
    { email: 'alice.work@gmail.com', fingerprint: 'bbbb', addedAt: '2026-01-01T00:00:00Z' },
    { email: 'bob@gmail.com', fingerprint: 'cccc', addedAt: '2026-01-01T00:00:00Z' },
  ],
};

describe('resolve', () => {
  it('matches exact email, 1-based index and label', () => {
    expect(resolve(index, 'bob@gmail.com').email).toBe('bob@gmail.com');
    expect(resolve(index, '1').email).toBe('alice@gmail.com');
    expect(resolve(index, 'personal').email).toBe('alice@gmail.com');
  });

  it('matches an unambiguous prefix but refuses an ambiguous one', () => {
    expect(resolve(index, 'bob').email).toBe('bob@gmail.com');
    expect(() => resolve(index, 'alice')).toThrow(/be more specific/);
  });

  it('reports missing profiles and out-of-range indexes', () => {
    expect(() => resolve(index, 'nobody')).toThrow(/no profile matching/);
    expect(() => resolve(index, '9')).toThrow(/no profile #9/);
  });
});

describe('upsert', () => {
  it('replaces by email and keeps the list sorted', () => {
    const next = upsert(index, { ...index.profiles[0]!, label: 'renamed' });
    expect(next.profiles).toHaveLength(3);
    expect(next.profiles.find((p) => p.email === 'alice@gmail.com')?.label).toBe('renamed');
    expect(next.profiles.map((p) => p.email)).toEqual([...next.profiles.map((p) => p.email)].sort());
  });
});

describe('fingerprint', () => {
  it('is stable and distinguishes tokens without exposing them', () => {
    const token = '1//0gjE4Raq_secret';
    expect(fingerprint(token)).toBe(fingerprint(token));
    expect(fingerprint(token)).not.toBe(fingerprint(token + 'x'));
    expect(fingerprint(token)).not.toContain('secret');
    expect(fingerprint(token)).toHaveLength(16);
  });
});

describe('agy credential blob', () => {
  const valid = JSON.stringify({
    token: { access_token: 'ya29.x', token_type: 'Bearer', refresh_token: '1//abc', expiry: '2026-08-10T11:15:02Z' },
    auth_method: 'consumer',
  });

  it('accepts the shape agy writes', () => {
    expect(parseBlob(valid).token.refresh_token).toBe('1//abc');
    expect(isAgyBlob(JSON.parse(valid))).toBe(true);
  });

  it('refuses anything without a refresh token, so we never install a dud', () => {
    expect(() => parseBlob('not json')).toThrow(/not JSON/);
    expect(() => parseBlob('{"token":{"access_token":"x"}}')).toThrow(/refresh_token/);
    expect(isAgyBlob({ token: null })).toBe(false);
  });
});

describe('quota parsing', () => {
  it('hides internal models and anything without a display name', () => {
    expect(shouldShowModel('claude-opus-4-6-thinking', { quotaInfo: {}, displayName: 'Claude' })).toBe(true);
    expect(shouldShowModel('tab_completion', { quotaInfo: {}, displayName: 'Tab' })).toBe(false);
    expect(shouldShowModel('chat_20706', { quotaInfo: {}, displayName: 'Chat' })).toBe(false);
    expect(shouldShowModel('gemini-3.6-flash-tiered', { quotaInfo: {} })).toBe(false);
    expect(shouldShowModel('claude-opus-4-6-thinking', { displayName: 'Claude' })).toBe(false);
  });

  it('maps the API response into a snapshot', () => {
    const nowMs = Date.parse('2026-08-10T06:00:00Z');
    const snapshot = parseSnapshot(
      { planInfo: { planType: 'FREE', monthlyPromptCredits: 100 }, availablePromptCredits: 40 },
      {
        models: {
          'z-model': {
            displayName: 'Zebra',
            quotaInfo: { remainingFraction: 0.5, resetTime: '2026-08-10T10:00:00Z' },
          },
          'a-model': {
            displayName: 'Apple',
            quotaInfo: { remainingFraction: 0, resetTime: '2026-08-10T04:00:00Z' },
          },
          tab_hidden: { displayName: 'Hidden', quotaInfo: { remainingFraction: 1 } },
        },
      },
      'alice@gmail.com',
      nowMs,
    );

    expect(snapshot.models.map((m) => m.label)).toEqual(['Apple', 'Zebra']);
    expect(snapshot.models[1]!.timeUntilResetMs).toBe(4 * 60 * 60 * 1000);
    // a reset time in the past is not a countdown
    expect(snapshot.models[0]!.timeUntilResetMs).toBeUndefined();
    expect(snapshot.models[0]!.isExhausted).toBe(true);
    expect(snapshot.planType).toBe('FREE');
    expect(snapshot.promptCredits).toEqual({ available: 40, monthly: 100, remainingPercentage: 0.4 });
  });

  it('groups model ids that share a display name into one quota pool', () => {
    const nowMs = Date.parse('2026-08-10T06:00:00Z');
    const snapshot = parseSnapshot(
      {},
      {
        models: {
          'gemini-2.5-flash': { displayName: 'Flash Lite', quotaInfo: { resetTime: '2026-08-11T18:00:00Z' } },
          'gemini-3.1-flash-lite': {
            displayName: 'Flash Lite',
            quotaInfo: { remainingFraction: 0.25, resetTime: '2026-08-10T18:00:00Z' },
          },
        },
      },
      'alice@gmail.com',
      nowMs,
    );

    expect(snapshot.models).toHaveLength(1);
    expect(snapshot.models[0]!.modelIds).toEqual(['gemini-2.5-flash', 'gemini-3.1-flash-lite']);
    expect(snapshot.models[0]!.remainingPercentage).toBe(0.25);
    // the soonest reset across the pool is the one that matters
    expect(snapshot.models[0]!.resetTime).toBe('2026-08-10T18:00:00Z');
  });

  it('reports the paid subscription, not the free-tier Code Assist licence', () => {
    const snapshot = parseSnapshot(
      {
        currentTier: { id: 'free-tier', name: 'Antigravity' },
        paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
      },
      { models: {} },
      'a@b.com',
    );
    expect(snapshot.planType).toBe('Google AI Pro');
  });

  it('falls back to the tier id when there is no plan info', () => {
    const snapshot = parseSnapshot({ currentTier: { id: 'free-tier' } }, { models: {} }, 'a@b.com');
    expect(snapshot.planType).toBe('free-tier');
    expect(snapshot.promptCredits).toBeUndefined();
  });
});

describe('render helpers', () => {
  it('formats durations', () => {
    expect(humanDuration(0)).toBe('now');
    expect(humanDuration(45 * 60_000)).toBe('45m');
    expect(humanDuration(4 * 3_600_000 + 41 * 60_000)).toBe('4h 41m');
    expect(humanDuration(50 * 3_600_000)).toBe('2d 2h');
  });

  it('draws a fixed-width bar and clamps out-of-range input', () => {
    const strip = (s: string) => s.replace(/[^█░]/g, '');
    expect(strip(bar(0.5, 10))).toBe('█████░░░░░');
    expect(strip(bar(-1, 4))).toBe('░░░░');
    expect(strip(bar(2, 4))).toBe('████');
  });
});

describe('model catalog', () => {
  it('flattens a snapshot into modelId -> label', () => {
    const catalog = catalogFromSnapshot({
      email: 'a@b.com',
      models: [
        { label: 'Flash Lite', modelIds: ['gemini-2.5-flash', 'gemini-3.1-flash-lite'], isExhausted: false },
        { label: 'Claude Opus', modelIds: ['claude-opus-4-6-thinking'], isExhausted: false },
      ],
    });
    expect(catalog).toEqual({
      'gemini-2.5-flash': 'Flash Lite',
      'gemini-3.1-flash-lite': 'Flash Lite',
      'claude-opus-4-6-thinking': 'Claude Opus',
    });
  });

  it('separates additions, removals and renames', () => {
    const diff = diffCatalog(
      { keep: 'Same', gone: 'Old Model', moved: 'Gemini 3.1 Pro' },
      { keep: 'Same', moved: 'Gemini 3.5 Pro', fresh: 'Gemini 4 Flash' },
    );
    expect(diff.added).toEqual([{ modelId: 'fresh', label: 'Gemini 4 Flash' }]);
    expect(diff.removed).toEqual([{ modelId: 'gone', label: 'Old Model' }]);
    expect(diff.renamed).toEqual([{ modelId: 'moved', from: 'Gemini 3.1 Pro', to: 'Gemini 3.5 Pro' }]);
    expect(isEmptyDiff(diff)).toBe(false);
    expect(describeDiff(diff)).toHaveLength(3);
  });

  it('reports no change when the lineup is identical', () => {
    const same = { a: 'A', b: 'B' };
    expect(isEmptyDiff(diffCatalog(same, { ...same }))).toBe(true);
  });
});

describe('keyring target naming', () => {
  it('matches the scheme agy uses, so we read its real entry', () => {
    expect(winTarget('gemini', 'antigravity')).toBe('gemini:antigravity');
  });
});

describe('guest browser shim', () => {
  it('puts a shim dir first on PATH and points it at Chrome in guest mode', () => {
    if (!chromePath()) return; // no Chrome on this machine: agyp falls back to the default browser
    const env = guestBrowserEnv({ PATH: '/existing' })!;
    const dir = env['PATH']!.split(delimiter)[0]!;
    const shim = process.platform === 'win32' ? 'rundll32.cmd' : 'xdg-open';
    const script = readFileSync(join(dir, shim), 'utf8');
    expect(script).toContain('--guest');
    expect(env['PATH']!.endsWith('/existing')).toBe(true);
    // cmd splits `url.dll,FileProtocolHandler` into two arguments, so a fixed
    // %2 opens "FileProtocolHandler" instead of the OAuth URL.
    if (process.platform === 'win32') {
      expect(script).not.toContain('%~2');
      expect(script).toContain('tokens=1,*');
    }
  });
});
