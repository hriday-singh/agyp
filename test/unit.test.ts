import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearLive, finalFrame, isAgyBlob, liveTokenFilePath, parseBlob, readLiveRaw, writeLive } from '../src/agy.js';
import { chromePath, guestBrowserEnv } from '../src/browser.js';
import { UserError, parseArgs } from '../src/args.js';
import { catalogFromSnapshot, describeDiff, diffCatalog, isEmptyDiff } from '../src/catalog.js';
import { parseSnapshot, shouldShowModel } from '../src/google.js';
import { COMMAND_HELP, HELP } from '../src/help.js';
import { validateLabel } from '../src/index.js';
import { winTarget } from '../src/keyring.js';
import { bar, humanDuration, renderWeeklyProfile, renderWeeklyReport, spinner } from '../src/render.js';
import { cmdSpinner, getRandomSpinnerText, SPINNER_TEXTS } from '../src/spinner.js';
import { calculatePlanStats, clearUsageCache, findHealthiestProfile, loadUsageCache, rankProfileHealth, recordUsageSnapshot } from '../src/stats.js';
import { COMMAND_ALIASES, findBestMatch, levenshtein } from '../src/suggest.js';
import { delSecret, fingerprint, getSecret, resolve, secretsDir, setSecret, upsert, vaultDir, type VaultIndex } from '../src/vault.js';
import { buildWeeklyReport, MS_PER_DAY, type ProfileWeeklyReport } from '../src/weekly.js';

describe('parseArgs', () => {
  it('splits command, positional, flags and passthrough', () => {
    const parsed = parseArgs(['run', 'work', '--force', '--', '--verbose', 'debug']);
    expect(parsed.command).toBe('run');
    expect(parsed.positional).toEqual(['work']);
    expect(parsed.flags.has('force')).toBe(true);
    expect(parsed.passthrough).toEqual(['--verbose', 'debug']);
  });

  it('reads --label as a value option, not a flag', () => {
    const parsed = parseArgs(['login', '--label', 'personal']);
    expect(parsed.options.get('label')).toBe('personal');
    expect(parsed.flags.has('label')).toBe(false);
    expect(parsed.positional).toEqual([]);
  });

  it('parses label and rename positional commands', () => {
    const p1 = parseArgs(['label', '1', 'work']);
    expect(p1.command).toBe('label');
    expect(p1.positional).toEqual(['1', 'work']);

    const p2 = parseArgs(['rename', 'personal', 'work']);
    expect(p2.command).toBe('rename');
    expect(p2.positional).toEqual(['personal', 'work']);

    const p3 = parseArgs(['label', 'personal', '--clear']);
    expect(p3.command).toBe('label');
    expect(p3.positional).toEqual(['personal']);
    expect(p3.flags.has('clear')).toBe(true);
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

describe('validateLabel', () => {
  it('accepts valid labels and trims whitespace', () => {
    expect(validateLabel('  hello  ')).toBe('hello');
    expect(validateLabel('work-1')).toBe('work-1');
  });

  it('rejects labels that are numbers only', () => {
    expect(() => validateLabel('123')).toThrow(/numbers only/);
    expect(() => validateLabel('1')).toThrow(/numbers only/);
  });

  it('rejects duplicate labels', () => {
    expect(() => validateLabel('personal', 'bob@gmail.com', index)).toThrow(/already used/);
    expect(validateLabel('personal', 'alice@gmail.com', index)).toBe('personal');
  });
});

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

describe('help text', () => {
  it('includes label command in general and command help', () => {
    expect(HELP).toContain('label <target> [name]');
    expect(COMMAND_HELP.label).toContain('agyp label');
    expect(COMMAND_HELP.label).toContain('agyp rename');
    expect(COMMAND_HELP.stats).toContain('agyp stats');
  });
});

describe('command aliases', () => {
  it('maps common aliases to primary commands', () => {
    expect(COMMAND_ALIASES.save).toBe('adopt');
    expect(COMMAND_ALIASES.add).toBe('login');
    expect(COMMAND_ALIASES.show).toBe('list');
    expect(COMMAND_ALIASES.select).toBe('use');
    expect(COMMAND_ALIASES.exec).toBe('run');
    expect(COMMAND_ALIASES.credits).toBe('usage');
    expect(COMMAND_ALIASES.upgrade).toBe('update');
    expect(COMMAND_ALIASES.info).toBe('status');
    expect(COMMAND_ALIASES.tag).toBe('label');
    expect(COMMAND_ALIASES.delete).toBe('remove');
    expect(COMMAND_ALIASES.check).toBe('doctor');
    expect(COMMAND_ALIASES.metrics).toBe('stats');
  });
});

describe('Did You Mean suggestions', () => {
  it('calculates Levenshtein edit distance', () => {
    expect(levenshtein('status', 'statuss')).toBe(1);
    expect(levenshtein('login', 'logn')).toBe(1);
    expect(levenshtein('cat', 'dog')).toBe(3);
  });

  it('finds best matching candidate', () => {
    expect(findBestMatch('statuss', ['status', 'list', 'run'])).toBe('status');
    expect(findBestMatch('personl', ['personal', 'work'])).toBe('personal');
    expect(findBestMatch('xyz123', ['status', 'list'])).toBeNull();
  });

  it('suggests closest match when profile target is not found in resolve()', () => {
    expect(() => resolve(index, 'personl')).toThrow(/did you mean "personal"\?/);
    expect(() => resolve(index, 'bo')).toBeDefined(); // matches bob@gmail.com by prefix!
  });
});

describe('usage & plan statistics', () => {
  it('calculates plan statistics across accounts', () => {
    const stats = calculatePlanStats([
      {
        email: 'pro@gmail.com',
        planType: 'Google AI Pro',
        promptCredits: { available: 80, monthly: 100, remainingPercentage: 0.8 },
        models: [{ label: 'Gemini 3.1 Pro', modelIds: ['gemini-3.1-pro'], remainingPercentage: 1, isExhausted: false }],
      },
      {
        email: 'free@gmail.com',
        planType: 'Free Tier',
        models: [{ label: 'Gemini 3.1 Pro', modelIds: ['gemini-3.1-pro'], remainingPercentage: 0, isExhausted: true }],
      },
    ]);

    expect(stats.totalProfiles).toBe(2);
    expect(stats.plans['Google AI Pro']).toBe(1);
    expect(stats.plans['Free Tier']).toBe(1);
    expect(stats.totalAvailableCredits).toBe(80);
    expect(stats.totalMonthlyCredits).toBe(100);
    expect(stats.bestProfileForUse?.email).toBe('pro@gmail.com');
  });

  it('caches and clears usage snapshots', () => {
    clearUsageCache();
    recordUsageSnapshot({
      email: 'user@gmail.com',
      planType: 'Google AI Pro',
      models: [],
    });

    const cache = loadUsageCache();
    expect(cache.snapshots['user@gmail.com']?.planType).toBe('Google AI Pro');

    clearUsageCache();
    const cleared = loadUsageCache();
    expect(Object.keys(cleared.snapshots)).toHaveLength(0);
  });
});

describe('spinner command and controller', () => {
  it('includes standard status messages in SPINNER_TEXTS', () => {
    expect(SPINNER_TEXTS).toContain('identifying account');
    expect(SPINNER_TEXTS).toContain('syncing current credential');
    expect(SPINNER_TEXTS).toContain('identifying new account');
    expect(SPINNER_TEXTS).toContain('loading profiles');
    expect(SPINNER_TEXTS).toContain('syncing credential');
    expect(SPINNER_TEXTS).toContain('syncing profile updates');
    expect(SPINNER_TEXTS).toContain('checking model lineup');
    expect(SPINNER_TEXTS).toContain('running health checks');
    expect(SPINNER_TEXTS.length).toBeGreaterThanOrEqual(8);
  });

  it('getRandomSpinnerText selects a valid text and excludes current if possible', () => {
    const text = getRandomSpinnerText();
    expect(SPINNER_TEXTS).toContain(text);

    const nextText = getRandomSpinnerText('identifying account');
    expect(SPINNER_TEXTS).toContain(nextText);
    expect(nextText).not.toBe('identifying account');
  });

  it('spinner creates controller with update method and stops cleanly', () => {
    const stop = spinner('initial test');
    expect(typeof stop).toBe('function');
    expect(typeof stop.update).toBe('function');
    expect(() => stop.update('updated test')).not.toThrow();
    expect(() => stop()).not.toThrow();
  });

  it('cmdSpinner validates input duration', async () => {
    await expect(cmdSpinner('-5')).rejects.toThrow(UserError);
    await expect(cmdSpinner('0')).rejects.toThrow(UserError);
    await expect(cmdSpinner('abc')).rejects.toThrow(UserError);
  });

  it('cmdSpinner executes with short duration', async () => {
    await expect(cmdSpinner('0.05')).resolves.toBeUndefined();
  });

  it('maps spin and loading aliases to spinner', () => {
    expect(COMMAND_ALIASES['spin']).toBe('spinner');
    expect(COMMAND_ALIASES['loading']).toBe('spinner');
  });

  it('documents spinner in help', () => {
    expect(HELP).toContain('spinner [seconds]');
    expect(COMMAND_HELP['spinner']).toBeDefined();
    expect(COMMAND_HELP['spinner']).toContain('agyp spinner');
  });
});


describe('finalFrame', () => {
  it('keeps only what agy left after its last redraw', () => {
    expect(finalFrame('\u25d0 checking\r\u25d3 checking\rfound new version 1.2.0')).toBe(
      'found new version 1.2.0',
    );
    expect(finalFrame('already up to date')).toBe('already up to date');
    expect(finalFrame('\r   \r  ')).toBe('');
  });
});

describe('token file and vault fallback', () => {
  it('liveTokenFilePath resolves to antigravity-oauth-token', () => {
    const defaultPath = liveTokenFilePath();
    expect(defaultPath.endsWith('antigravity-oauth-token')).toBe(true);

    const oldEnv = process.env.GEMINI_CLI_DATA_DIR;
    try {
      process.env.GEMINI_CLI_DATA_DIR = '/custom/data/dir';
      expect(liveTokenFilePath()).toBe(join('/custom/data/dir', 'antigravity-oauth-token'));
    } finally {
      if (oldEnv === undefined) delete process.env.GEMINI_CLI_DATA_DIR;
      else process.env.GEMINI_CLI_DATA_DIR = oldEnv;
    }
  });

  it('file fallback handles live token write, read and clear', () => {
    const testDir = join(tmpdir(), `agyp-test-token-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const oldEnv = process.env.GEMINI_CLI_DATA_DIR;
    process.env.GEMINI_CLI_DATA_DIR = testDir;

    const sample = JSON.stringify({
      token: { access_token: 'test_access', token_type: 'Bearer', refresh_token: 'test_refresh', expiry: '2026-08-10T11:15:02Z' },
      auth_method: 'consumer',
    });

    try {
      writeLive(sample);
      const readBack = readLiveRaw();
      expect(readBack).toBe(sample);
      expect(existsSync(join(testDir, 'antigravity-oauth-token'))).toBe(true);

      clearLive();
      expect(existsSync(join(testDir, 'antigravity-oauth-token'))).toBe(false);
    } finally {
      if (oldEnv === undefined) delete process.env.GEMINI_CLI_DATA_DIR;
      else process.env.GEMINI_CLI_DATA_DIR = oldEnv;
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('vault secret storage fallback persists and removes secrets', () => {
    const testVault = join(tmpdir(), `agyp-test-vault-${Date.now()}`);
    mkdirSync(testVault, { recursive: true });
    const oldHome = process.env.AGYP_HOME;
    process.env.AGYP_HOME = testVault;

    try {
      const email = 'fallback-test@example.com';
      const secretData = 'test-secret-payload';

      setSecret(email, secretData);
      const fetched = getSecret(email);
      expect(fetched).toBe(secretData);

      delSecret(email);
      const deleted = getSecret(email);
      expect(deleted).toBeNull();
    } finally {
      if (oldHome === undefined) delete process.env.AGYP_HOME;
      else process.env.AGYP_HOME = oldHome;
      rmSync(testVault, { recursive: true, force: true });
    }
  });
});

describe('weekly quota tracking & forecasting', () => {
  const baseNow = Date.parse('2026-08-19T10:00:00Z');

  it('builds weekly report and identifies the earliest reset', () => {
    const report = buildWeeklyReport(
      {
        email: 'bonka@gmail.com',
        planType: 'Google AI Pro',
        models: [
          {
            label: 'Gemini 3.1 Pro (High)',
            modelIds: ['gemini-3.1-pro-high'],
            remainingPercentage: 0.4,
            isExhausted: false,
            resetTime: '2026-08-20T14:00:00Z', // 28 hours later -> weekly / multi-day
          },
          {
            label: 'Claude Sonnet 4.6 (Thinking)',
            modelIds: ['claude-sonnet-4-6'],
            remainingPercentage: 0,
            isExhausted: true,
            resetTime: '2026-08-22T18:00:00Z', // 3 days 8 hours later
          },
          {
            label: 'Gemini 3.1 Flash Lite',
            modelIds: ['gemini-3.1-flash-lite'],
            remainingPercentage: 0.9,
            isExhausted: false,
            resetTime: '2026-08-19T14:30:00Z', // 4.5 hours later -> rolling pool
          },
        ],
      },
      'bonka',
      baseNow,
    );

    expect(report.email).toBe('bonka@gmail.com');
    expect(report.label).toBe('bonka');
    expect(report.planType).toBe('Google AI Pro');
    expect(report.totalModels).toBe(3);
    expect(report.exhaustedCount).toBe(1);
    expect(report.lowCount).toBe(0);
    expect(report.healthyCount).toBe(2);

    // Earliest reset should be Gemini 3.1 Flash Lite (4h 30m away)
    expect(report.earliestReset).toBeDefined();
    expect(report.earliestReset?.modelLabel).toBe('Gemini 3.1 Flash Lite');
    expect(report.earliestReset?.humanDuration).toBe('4h 30m');

    // Categorization:
    // Gemini 3.1 Pro (28h) and Claude (80h) > 24h -> weeklyModels
    // Gemini 3.1 Flash Lite (4.5h) <= 24h -> rollingModels
    expect(report.weeklyModels.map((m) => m.label)).toEqual([
      'Gemini 3.1 Pro (High)',
      'Claude Sonnet 4.6 (Thinking)',
    ]);
    expect(report.rollingModels.map((m) => m.label)).toEqual(['Gemini 3.1 Flash Lite']);
  });

  it('handles models with no reset time and models that are low on capacity', () => {
    const report = buildWeeklyReport(
      {
        email: 'user@gmail.com',
        models: [
          {
            label: 'GPT-OSS 120B',
            modelIds: ['gpt-oss-120b'],
            remainingPercentage: 0.1, // low (< 20%)
            isExhausted: false,
          },
          {
            label: 'Gemini 2.5 Pro',
            modelIds: ['gemini-2.5-pro'],
            remainingPercentage: 0.8,
            isExhausted: false,
          },
        ],
      },
      'work',
      baseNow,
    );

    expect(report.earliestReset).toBeUndefined();
    expect(report.lowCount).toBe(1);
    expect(report.healthyCount).toBe(1);
    expect(report.exhaustedCount).toBe(0);
    expect(report.weeklyModels).toHaveLength(0);
    expect(report.rollingModels).toHaveLength(2);
  });

  it('renders weekly profile and report outputs with colors and formatting', () => {
    const report: ProfileWeeklyReport = {
      email: 'bonka@gmail.com',
      label: 'bonka',
      planType: 'Google AI Pro',
      earliestReset: {
        modelLabel: 'Gemini 3.1 Pro',
        timeUntilResetMs: 28 * 3600 * 1000,
        humanDuration: '1d 4h',
      },
      weeklyModels: [
        {
          label: 'Gemini 3.1 Pro',
          modelIds: ['gemini-3.1-pro'],
          remainingPercentage: 0.5,
          isExhausted: false,
          timeUntilResetMs: 28 * 3600 * 1000,
        },
      ],
      rollingModels: [
        {
          label: 'Gemini Flash',
          modelIds: ['gemini-flash'],
          remainingPercentage: 1,
          isExhausted: false,
          timeUntilResetMs: 2 * 3600 * 1000,
        },
      ],
      exhaustedCount: 0,
      lowCount: 0,
      healthyCount: 2,
      totalModels: 2,
    };

    const rendered = renderWeeklyProfile(report);
    expect(rendered).toContain('bonka (bonka@gmail.com)');
    expect(rendered).toContain('Google AI Pro');
    expect(rendered).toContain('Earliest reset:');
    expect(rendered).toContain('1d 4h');
    expect(rendered).toContain('Weekly / Multi-Day Pools:');
    expect(rendered).toContain('Rolling / Daily Pools:');
    expect(rendered).toContain('2 healthy');

    const fullReport = renderWeeklyReport([report]);
    expect(fullReport).toContain('bonka (bonka@gmail.com)');

    const emptyReport = renderWeeklyReport([]);
    expect(emptyReport).toContain('no profiles available');
  });

  it('maps weekly aliases and updates command help', () => {
    expect(COMMAND_ALIASES.week).toBe('weekly');
    expect(COMMAND_ALIASES.forecast).toBe('weekly');
    expect(COMMAND_ALIASES.resets).toBe('weekly');
    expect(COMMAND_ALIASES.schedule).toBe('weekly');

    expect(HELP).toContain('weekly [target]');
    expect(HELP).toContain('--weekly');
    expect(COMMAND_HELP.weekly).toBeDefined();
    expect(COMMAND_HELP.weekly).toContain('agyp weekly');
  });

  it('parses --weekly flag from arguments', () => {
    const p1 = parseArgs(['usage', '--weekly']);
    expect(p1.command).toBe('usage');
    expect(p1.flags.has('weekly')).toBe(true);

    const p2 = parseArgs(['weekly', 'bonka', '--json']);
    expect(p2.command).toBe('weekly');
    expect(p2.positional).toEqual(['bonka']);
    expect(p2.flags.has('json')).toBe(true);
  });
});

describe('healthiest profile auto-selection', () => {
  it('ranks profiles by health score and chooses zero-exhausted over exhausted pools', () => {
    const snapshots = [
      {
        email: 'exhausted@gmail.com',
        models: [
          { label: 'Gemini 3.1 Pro', modelIds: ['gemini-3.1-pro'], remainingPercentage: 0, isExhausted: true },
          { label: 'Claude', modelIds: ['claude'], remainingPercentage: 1, isExhausted: false },
        ],
      },
      {
        email: 'healthy@gmail.com',
        models: [
          { label: 'Gemini 3.1 Pro', modelIds: ['gemini-3.1-pro'], remainingPercentage: 0.8, isExhausted: false },
          { label: 'Claude', modelIds: ['claude'], remainingPercentage: 0.7, isExhausted: false },
        ],
      },
    ];

    const ranked = snapshots.map(rankProfileHealth);
    expect(ranked.find((r) => r.email === 'healthy@gmail.com')?.exhaustedCount).toBe(0);
    expect(ranked.find((r) => r.email === 'exhausted@gmail.com')?.exhaustedCount).toBe(1);

    const healthiest = findHealthiestProfile(snapshots);
    expect(healthiest?.email).toBe('healthy@gmail.com');
  });

  it('selects profile with highest average quota among healthy accounts', () => {
    const snapshots = [
      {
        email: 'medium@gmail.com',
        models: [
          { label: 'Gemini 3.1 Pro', modelIds: ['gemini-3.1-pro'], remainingPercentage: 0.5, isExhausted: false },
        ],
      },
      {
        email: 'high@gmail.com',
        models: [
          { label: 'Gemini 3.1 Pro', modelIds: ['gemini-3.1-pro'], remainingPercentage: 0.95, isExhausted: false },
        ],
      },
    ];

    const healthiest = findHealthiestProfile(snapshots);
    expect(healthiest?.email).toBe('high@gmail.com');
    expect(healthiest?.avgQuotaPercentage).toBe(95);
  });

  it('preserves active account if tied for top score', () => {
    const snapshots = [
      {
        email: 'account-a@gmail.com',
        models: [{ label: 'Model', modelIds: ['m'], remainingPercentage: 1, isExhausted: false }],
      },
      {
        email: 'account-b@gmail.com',
        models: [{ label: 'Model', modelIds: ['m'], remainingPercentage: 1, isExhausted: false }],
      },
    ];

    const pickA = findHealthiestProfile(snapshots, 'account-a@gmail.com');
    expect(pickA?.email).toBe('account-a@gmail.com');

    const pickB = findHealthiestProfile(snapshots, 'account-b@gmail.com');
    expect(pickB?.email).toBe('account-b@gmail.com');
  });

  it('handles empty snapshots gracefully', () => {
    expect(findHealthiestProfile([])).toBeNull();
  });

  it('maps auto and autorun aliases and updates command help', () => {
    expect(COMMAND_ALIASES.best).toBe('auto');
    expect(COMMAND_ALIASES.pick).toBe('auto');
    expect(COMMAND_ALIASES['auto-use']).toBe('auto');
    expect(COMMAND_ALIASES['auto-run']).toBe('autorun');
    expect(COMMAND_ALIASES['run-auto']).toBe('autorun');

    expect(HELP).toContain('auto');
    expect(HELP).toContain('autorun');
    expect(HELP).toContain('--auto');
    expect(COMMAND_HELP.auto).toBeDefined();
    expect(COMMAND_HELP.auto).toContain('agyp auto');
    expect(COMMAND_HELP.autorun).toBeDefined();
    expect(COMMAND_HELP.autorun).toContain('agyp autorun');
  });

  it('parses auto commands and flags', () => {
    const p1 = parseArgs(['use', '--auto']);
    expect(p1.command).toBe('use');
    expect(p1.flags.has('auto')).toBe(true);

    const p2 = parseArgs(['run', '--auto', '--', '--verbose']);
    expect(p2.command).toBe('run');
    expect(p2.flags.has('auto')).toBe(true);
    expect(p2.passthrough).toEqual(['--verbose']);

    const p3 = parseArgs(['auto']);
    expect(p3.command).toBe('auto');

    const p4 = parseArgs(['autorun', '--', 'start']);
    expect(p4.command).toBe('autorun');
    expect(p4.passthrough).toEqual(['start']);
  });
});
