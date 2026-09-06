/**
 * Weekly Quota Tracking & Replenishment Forecasting.
 *
 * Analyzes model quotas per profile/handle, identifying the earliest upcoming
 * reset and categorizing models into weekly/multi-day pools and short-cycle rolling pools.
 */
import { UserError } from './args.js';
import { trackCatalog } from './catalog.js';
import type { ModelQuota, Snapshot } from './google.js';
import { bold, humanDuration, red, renderWeeklyReport, spinner } from './render.js';
import { recordUsageSnapshot } from './stats.js';
import { loadIndex, resolve, type ProfileMeta } from './vault.js';

export interface ResetForecast {
  modelLabel: string;
  resetTime?: string;
  timeUntilResetMs?: number;
  humanDuration: string;
}

export interface ProfileWeeklyReport {
  email: string;
  label?: string;
  planType?: string;
  earliestReset?: ResetForecast;
  weeklyModels: ModelQuota[];
  rollingModels: ModelQuota[];
  exhaustedCount: number;
  lowCount: number;
  healthyCount: number;
  totalModels: number;
}

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function getModelResetMs(model: ModelQuota, now = Date.now()): number | undefined {
  if (model.resetTime) {
    const ms = new Date(model.resetTime).getTime() - now;
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  if (model.timeUntilResetMs !== undefined && Number.isFinite(model.timeUntilResetMs) && model.timeUntilResetMs > 0) {
    return model.timeUntilResetMs;
  }
  return undefined;
}

/**
 * Builds a weekly status report and reset forecast for a single profile snapshot.
 */
export function buildWeeklyReport(
  snapshot: Snapshot,
  label?: string,
  now = Date.now(),
): ProfileWeeklyReport {
  let earliestReset: ResetForecast | undefined;
  let minResetMs = Infinity;

  const weeklyModels: ModelQuota[] = [];
  const rollingModels: ModelQuota[] = [];

  let exhaustedCount = 0;
  let lowCount = 0;
  let healthyCount = 0;

  for (const rawModel of snapshot.models) {
    const isExhausted = rawModel.isExhausted || rawModel.remainingPercentage === 0;
    if (isExhausted) {
      exhaustedCount++;
    } else if (rawModel.remainingPercentage !== undefined && rawModel.remainingPercentage < 0.2) {
      lowCount++;
    } else {
      healthyCount++;
    }

    const validResetMs = getModelResetMs(rawModel, now);
    const model: ModelQuota = {
      ...rawModel,
      timeUntilResetMs: validResetMs ?? rawModel.timeUntilResetMs,
    };

    if (validResetMs !== undefined && validResetMs < minResetMs) {
      minResetMs = validResetMs;
      earliestReset = {
        modelLabel: model.label,
        resetTime: model.resetTime,
        timeUntilResetMs: validResetMs,
        humanDuration: humanDuration(validResetMs),
      };
    }

    // Categorize: > 24 hours is weekly / multi-day pool
    if (validResetMs !== undefined && validResetMs > MS_PER_DAY) {
      weeklyModels.push(model);
    } else {
      rollingModels.push(model);
    }
  }

  // Sort weekly models by soonest reset first, then by label
  weeklyModels.sort((a, b) => {
    const aMs = getModelResetMs(a, now) ?? Infinity;
    const bMs = getModelResetMs(b, now) ?? Infinity;
    if (aMs !== bMs) return aMs - bMs;
    return a.label.localeCompare(b.label);
  });

  // Sort rolling models by soonest reset first, then by label
  rollingModels.sort((a, b) => {
    const aMs = getModelResetMs(a, now) ?? Infinity;
    const bMs = getModelResetMs(b, now) ?? Infinity;
    if (aMs !== bMs) return aMs - bMs;
    return a.label.localeCompare(b.label);
  });

  return {
    email: snapshot.email,
    label,
    planType: snapshot.planType,
    earliestReset,
    weeklyModels,
    rollingModels,
    exhaustedCount,
    lowCount,
    healthyCount,
    totalModels: snapshot.models.length,
  };
}

export async function cmdWeekly(
  target: string | undefined,
  json: boolean,
  fetchSnapshot: (profile: ProfileMeta) => Promise<{ snapshot: Snapshot; projectId?: string }>,
): Promise<void> {
  const index = loadIndex();
  if (index.profiles.length === 0) throw new UserError('no profiles yet — run `agyp adopt` or `agyp login`');

  const all = !target;
  const targets = all ? index.profiles : [resolve(index, target)];

  const stop = spinner(
    targets.length > 1
      ? `checking weekly quota for ${targets.length} accounts`
      : `checking weekly quota for ${targets[0]!.email}`,
  );
  const results = await Promise.allSettled(targets.map(fetchSnapshot)).finally(stop);
  const reports: ProfileWeeklyReport[] = [];
  const errors: { email: string; reason: string }[] = [];

  results.forEach((result, i) => {
    const profile = targets[i]!;
    if (result.status === 'rejected') {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push({ email: profile.email, reason });
      if (json) {
        reports.push({
          email: profile.email,
          label: profile.label,
          weeklyModels: [],
          rollingModels: [],
          exhaustedCount: 0,
          lowCount: 0,
          healthyCount: 0,
          totalModels: 0,
        });
      }
      return;
    }
    recordUsageSnapshot(result.value.snapshot);
    trackCatalog(result.value.snapshot);
    const report = buildWeeklyReport(result.value.snapshot, profile.label);
    reports.push(report);
  });

  if (json) {
    console.log(JSON.stringify(all ? reports : reports[0], null, 2));
    return;
  }

  for (const err of errors) {
    console.log(`${bold(err.email)}\n  ${red(err.reason)}\n`);
  }

  if (reports.length > 0) {
    console.log(renderWeeklyReport(reports));
  }
}
