import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearLive, liveTokenFilePath, readLiveRaw, writeLive } from '../src/agy.js';
import { UserError } from '../src/args.js';
import { browserShimDir } from '../src/browser.js';
import { loadCatalog, removeCatalog, saveCatalog } from '../src/catalog.js';
import { secretsInBinary } from '../src/google.js';
import {
  calculatePlanStats,
  clearUsageCache,
  findHealthiestProfile,
  loadUsageCache,
  rankProfileHealth,
  recordUsageSnapshot,
  recordUsageSnapshots,
  removeUsageSnapshot,
} from '../src/stats.js';
import { delSecret, getSecret, pickDefault, setSecret, vaultDir, type VaultIndex } from '../src/vault.js';

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

  it('batches snapshot writes and removes individual snapshots', () => {
    clearUsageCache();
    recordUsageSnapshots([
      { email: 'snap1@gmail.com', models: [] },
      { email: 'snap2@gmail.com', models: [] },
    ]);

    let cache = loadUsageCache();
    expect(cache.snapshots['snap1@gmail.com']).toBeDefined();
    expect(cache.snapshots['snap2@gmail.com']).toBeDefined();

    removeUsageSnapshot('snap1@gmail.com');
    cache = loadUsageCache();
    expect(cache.snapshots['snap1@gmail.com']).toBeUndefined();
    expect(cache.snapshots['snap2@gmail.com']).toBeDefined();

    clearUsageCache();
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

  it('handles empty models gracefully with 0 avg quota', () => {
    const health = rankProfileHealth({ email: 'empty@gmail.com', models: [] });
    expect(health.avgQuotaPercentage).toBe(0);
    expect(health.exhaustedCount).toBe(0);
    expect(health.score).toBe(0);
  });

  it('prioritizes models with higher Gemini quota when exhausted count is identical', () => {
    const snapshots = [
      {
        email: 'lower-gemini@gmail.com',
        models: [
          { label: 'Gemini 3.1 Pro', modelIds: ['gemini-3.1-pro'], remainingPercentage: 0.2, isExhausted: false },
          { label: 'Claude 3.7 Sonnet', modelIds: ['claude-3.7-sonnet'], remainingPercentage: 0.9, isExhausted: false },
        ],
      },
      {
        email: 'higher-gemini@gmail.com',
        models: [
          { label: 'Gemini 3.1 Pro', modelIds: ['gemini-3.1-pro'], remainingPercentage: 0.8, isExhausted: false },
          { label: 'Claude 3.7 Sonnet', modelIds: ['claude-3.7-sonnet'], remainingPercentage: 0.1, isExhausted: false },
        ],
      },
    ];

    const healthiest = findHealthiestProfile(snapshots);
    expect(healthiest?.email).toBe('higher-gemini@gmail.com');
  });

  it('breaks ties on Gemini quota using Claude quota', () => {
    const snapshots = [
      {
        email: 'low-claude@gmail.com',
        models: [
          { label: 'Gemini 3.1 Pro', modelIds: ['gemini-3.1-pro'], remainingPercentage: 0.8, isExhausted: false },
          { label: 'Claude 3.7 Sonnet', modelIds: ['claude-3.7-sonnet'], remainingPercentage: 0.3, isExhausted: false },
        ],
      },
      {
        email: 'high-claude@gmail.com',
        models: [
          { label: 'Gemini 3.1 Pro', modelIds: ['gemini-3.1-pro'], remainingPercentage: 0.8, isExhausted: false },
          { label: 'Claude 3.7 Sonnet', modelIds: ['claude-3.7-sonnet'], remainingPercentage: 0.9, isExhausted: false },
        ],
      },
    ];

    const healthiest = findHealthiestProfile(snapshots);
    expect(healthiest?.email).toBe('high-claude@gmail.com');
  });
});

describe('secretsInBinary', () => {
  it('pulls every distinct desktop client secret out of a binary, in order', () => {
    const a = 'GOCSPX-' + 'a'.repeat(28);
    const b = 'GOCSPX-' + 'B_-9'.repeat(7);
    const bin = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`${a}\0GOCSPX-short\0${b}${a}`), Buffer.from([255])]);
    expect(secretsInBinary(bin)).toEqual([a, b]);
  });
});

describe('removeCatalog and browserShimDir', () => {
  it('removes catalog entries safely', () => {
    const testHome = join(tmpdir(), `agyp-test-cat-${Date.now()}`);
    mkdirSync(testHome, { recursive: true });
    const oldHome = process.env.AGYP_HOME;
    process.env.AGYP_HOME = testHome;

    try {
      const email = 'cat-test@example.com';
      saveCatalog(email, { 'gemini-test': 'Gemini Test' });
      expect(loadCatalog(email)).not.toBeNull();

      removeCatalog(email);
      expect(loadCatalog(email)).toBeNull();

      // Idempotent when profile doesn't exist
      expect(() => removeCatalog(email)).not.toThrow();
    } finally {
      if (oldHome === undefined) delete process.env.AGYP_HOME;
      else process.env.AGYP_HOME = oldHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it('creates and returns persistent browser shim dir', () => {
    const testHome = join(tmpdir(), `agyp-shim-${Date.now()}`);
    const oldHome = process.env.AGYP_HOME;
    process.env.AGYP_HOME = testHome;
    try {
      const dir = browserShimDir();
      expect(existsSync(dir)).toBe(true);
      expect(dir).toContain('browser-shim');
    } finally {
      if (oldHome === undefined) delete process.env.AGYP_HOME;
      else process.env.AGYP_HOME = oldHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});

describe('pickDefault', () => {
  it('falls back to the first profile when no profile is active', () => {
    const testDir = join(tmpdir(), `agyp-pickdefault-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const oldEnv = process.env.GEMINI_CLI_DATA_DIR;
    process.env.GEMINI_CLI_DATA_DIR = testDir;

    try {
      const index: VaultIndex = {
        version: 1,
        profiles: [
          { email: 'a@example.com', fingerprint: '1', addedAt: '' },
          { email: 'b@example.com', fingerprint: '2', addedAt: '' },
        ],
      };
      expect(pickDefault(index).email).toBe('a@example.com');
    } finally {
      if (oldEnv === undefined) delete process.env.GEMINI_CLI_DATA_DIR;
      else process.env.GEMINI_CLI_DATA_DIR = oldEnv;
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('throws UserError when there are no profiles', () => {
    const index: VaultIndex = { version: 1, profiles: [] };
    expect(() => pickDefault(index)).toThrow(/no profiles found/);
  });
});
