/**
 * Plan & Model Quota Usage Statistics.
 *
 * Persists and aggregates quota snapshots across accounts, subscription plan tiers,
 * prompt credit pools, and model exhaustion states.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Snapshot } from './google.js';
import { bar, bold, cyan, dim, green, red, yellow } from './render.js';
import { loadIndex, vaultDir } from './vault.js';

export interface UsageCacheFile {
  version: 1;
  lastUpdated: string;
  snapshots: Record<string, Snapshot>;
}

export function usageCachePath(): string {
  return join(vaultDir(), 'usage_stats.json');
}

export function loadUsageCache(): UsageCacheFile {
  const path = usageCachePath();
  const defaultCache: UsageCacheFile = {
    version: 1,
    lastUpdated: new Date().toISOString(),
    snapshots: {},
  };

  if (!existsSync(path)) return defaultCache;

  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<UsageCacheFile>;
    return {
      version: 1,
      lastUpdated: parsed.lastUpdated ?? defaultCache.lastUpdated,
      snapshots: parsed.snapshots ?? {},
    };
  } catch {
    return defaultCache;
  }
}

export function recordUsageSnapshot(snapshot: Snapshot): void {
  const cache = loadUsageCache();
  cache.lastUpdated = new Date().toISOString();
  cache.snapshots[snapshot.email] = snapshot;

  try {
    mkdirSync(vaultDir(), { recursive: true, mode: 0o700 });
    writeFileSync(usageCachePath(), JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 });
  } catch {
    // Non-fatal if cache saving fails
  }
}

export function clearUsageCache(): void {
  const cache: UsageCacheFile = {
    version: 1,
    lastUpdated: new Date().toISOString(),
    snapshots: {},
  };
  try {
    writeFileSync(usageCachePath(), JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 });
  } catch {
    /* ignore */
  }
}

export interface PlanStatistics {
  totalProfiles: number;
  plans: Record<string, number>;
  totalAvailableCredits: number;
  totalMonthlyCredits: number;
  modelStats: Record<string, { totalRemainingFrac: number; count: number; exhaustedCount: number }>;
  bestProfileForUse?: { email: string; avgQuotaPercentage: number };
}

export function calculatePlanStats(snapshots: Snapshot[]): PlanStatistics {
  const plans: Record<string, number> = {};
  let totalAvailableCredits = 0;
  let totalMonthlyCredits = 0;
  const modelStats: Record<string, { totalRemainingFrac: number; count: number; exhaustedCount: number }> = {};

  let highestAvgQuota = -1;
  let bestEmail: string | undefined;

  for (const snap of snapshots) {
    const plan = snap.planType || 'Unknown';
    plans[plan] = (plans[plan] ?? 0) + 1;

    if (snap.promptCredits) {
      totalAvailableCredits += snap.promptCredits.available;
      totalMonthlyCredits += snap.promptCredits.monthly;
    }

    let profileQuotaSum = 0;
    let profileQuotaCount = 0;

    for (const m of snap.models) {
      const entry = modelStats[m.label] || { totalRemainingFrac: 0, count: 0, exhaustedCount: 0 };
      const frac = m.remainingPercentage ?? (m.isExhausted ? 0 : 1);
      entry.totalRemainingFrac += frac;
      entry.count += 1;
      if (m.isExhausted) entry.exhaustedCount += 1;
      modelStats[m.label] = entry;

      profileQuotaSum += frac;
      profileQuotaCount += 1;
    }

    const avgQuota = profileQuotaCount > 0 ? profileQuotaSum / profileQuotaCount : 0;
    if (avgQuota > highestAvgQuota) {
      highestAvgQuota = avgQuota;
      bestEmail = snap.email;
    }
  }

  return {
    totalProfiles: snapshots.length,
    plans,
    totalAvailableCredits,
    totalMonthlyCredits,
    modelStats,
    bestProfileForUse: bestEmail ? { email: bestEmail, avgQuotaPercentage: Math.round(highestAvgQuota * 100) } : undefined,
  };
}

export function cmdStats(json: boolean, reset: boolean): void {
  if (reset) {
    clearUsageCache();
    console.log(`${green('cleared')} cached usage statistics`);
    return;
  }

  const index = loadIndex();
  const cache = loadUsageCache();
  const snapshots = Object.values(cache.snapshots);

  if (json) {
    const stats = calculatePlanStats(snapshots);
    console.log(JSON.stringify({ lastUpdated: cache.lastUpdated, stats, cachedSnapshots: snapshots }, null, 2));
    return;
  }

  if (snapshots.length === 0) {
    console.log(dim('no usage statistics cached yet — run `agyp usage` to fetch model & plan data across accounts'));
    return;
  }

  const stats = calculatePlanStats(snapshots);

  console.log(bold('agyp usage & plan statistics'));
  console.log(dim(`  based on data for ${snapshots.length} account(s), updated ${cache.lastUpdated.slice(0, 10)}\n`));

  console.log(bold('Subscription Plans'));
  for (const [plan, count] of Object.entries(stats.plans)) {
    console.log(`  ${cyan(plan.padEnd(20))} ${yellow(String(count).padStart(2))} profile(s)`);
  }

  if (stats.totalMonthlyCredits > 0) {
    const frac = stats.totalAvailableCredits / stats.totalMonthlyCredits;
    const pct = `${Math.round(frac * 100)}%`.padStart(4);
    console.log(bold('\nPrompt Credits (Combined)'));
    console.log(
      `  ${'Prompt credits'.padEnd(34)} ${bar(frac, 15)} ${pct} (${stats.totalAvailableCredits} / ${stats.totalMonthlyCredits} available)`,
    );
  }

  console.log(bold('\nModel Quota Pools (Average Across Accounts)'));
  for (const [model, data] of Object.entries(stats.modelStats).sort((a, b) => a[0].localeCompare(b[0]))) {
    const avgFrac = data.count > 0 ? data.totalRemainingFrac / data.count : 0;
    const exhaustedStr = data.exhaustedCount > 0 ? red(` (${data.exhaustedCount} exhausted)`) : '';
    const name = model.length > 32 ? model.slice(0, 31) + '…' : model;
    const pct = `${Math.round(avgFrac * 100)}%`.padStart(4);
    console.log(`  ${name.padEnd(34)} ${bar(avgFrac, 15)} ${pct} avg${exhaustedStr}`);
  }

  if (stats.bestProfileForUse) {
    console.log(bold('\nRecommended Profile'));
    console.log(`  ${green('●')} ${bold(stats.bestProfileForUse.email)} ${dim(`(${stats.bestProfileForUse.avgQuotaPercentage}% average capacity)`)}`);
  }
}
