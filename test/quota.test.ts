import { describe, expect, it } from 'vitest';
import { CLOUDCODE, matchModelToGroup, parseQuotaGroups, parseSnapshot, shouldShowModel } from '../src/google.js';
import { bar, humanDuration, renderSnapshot } from '../src/render.js';

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

  it('parses quota groups and buckets from retrieveUserQuotaSummary', () => {
    const nowMs = Date.parse('2026-09-06T12:00:00Z');
    const groups = parseQuotaGroups(
      {
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
            buckets: [
              {
                bucketId: 'gemini-weekly',
                displayName: 'Weekly Limit Remaining',
                window: 'weekly',
                resetTime: '2026-09-08T12:00:00Z',
                remainingFraction: 0.54,
              },
              {
                bucketId: 'gemini-5h',
                displayName: 'Five Hour Limit Remaining',
                window: '5h',
                resetTime: '2026-09-06T17:00:00Z',
                remainingFraction: 1,
              },
            ],
          },
        ],
      },
      nowMs,
    );

    expect(groups).toBeDefined();
    expect(groups).toHaveLength(1);
    expect(groups![0]!.displayName).toBe('Gemini Models');
    expect(groups![0]!.buckets).toHaveLength(2);
    expect(groups![0]!.buckets[0]!.remainingFraction).toBe(0.54);
    expect(groups![0]!.buckets[0]!.timeUntilResetMs).toBe(2 * 24 * 60 * 60 * 1000);
    expect(groups![0]!.buckets[1]!.timeUntilResetMs).toBe(5 * 60 * 60 * 1000);
  });

  it('preserves undefined remainingFraction when bucket is unmetered', () => {
    const groups = parseQuotaGroups({
      groups: [
        {
          displayName: 'Special Bucket',
          buckets: [
            {
              bucketId: 'unmetered',
              displayName: 'Unmetered Pool',
            },
          ],
        },
      ],
    });

    expect(groups).toBeDefined();
    expect(groups![0]!.buckets[0]!.remainingFraction).toBeUndefined();
  });

  it('matches models to groups by model family and keywords', () => {
    const groups = [
      { displayName: 'Gemini Models', description: 'Models within this group: Gemini Flash, Gemini Pro', buckets: [] },
      { displayName: 'Claude and GPT models', description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS', buckets: [] },
    ];

    expect(matchModelToGroup('gemini-3.1-pro-high', 'Gemini 3.1 Pro (High)', groups)?.displayName).toBe('Gemini Models');
    expect(matchModelToGroup('claude-sonnet-4-6', 'Claude Sonnet 4.6 (Thinking)', groups)?.displayName).toBe('Claude and GPT models');
    expect(matchModelToGroup('gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)', groups)?.displayName).toBe('Claude and GPT models');
  });

  it('integrates quota summary into snapshot, reflecting true used weekly quota', () => {
    const nowMs = Date.parse('2026-09-06T12:00:00Z');
    const snapshot = parseSnapshot(
      { paidTier: { name: 'Google AI Pro' } },
      {
        models: {
          'gemini-3.1-pro-high': {
            displayName: 'Gemini 3.1 Pro (High)',
            quotaInfo: { remainingFraction: 1, resetTime: '2026-09-06T17:00:00Z' },
          },
          'claude-opus-4-6-thinking': {
            displayName: 'Claude Opus 4.6 (Thinking)',
            quotaInfo: { remainingFraction: 1, resetTime: '2026-09-06T17:00:00Z' },
          },
        },
      },
      'brawl@gmail.com',
      nowMs,
      {
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
            buckets: [
              {
                bucketId: 'gemini-weekly',
                displayName: 'Weekly Limit Remaining',
                window: 'weekly',
                resetTime: '2026-09-08T12:00:00Z',
                remainingFraction: 0.54,
              },
              {
                bucketId: 'gemini-5h',
                displayName: 'Five Hour Limit Remaining',
                window: '5h',
                resetTime: '2026-09-06T17:00:00Z',
                remainingFraction: 1,
              },
            ],
          },
          {
            displayName: 'Claude and GPT models',
            description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
            buckets: [
              {
                bucketId: '3p-weekly',
                displayName: 'Weekly Limit Remaining',
                window: 'weekly',
                resetTime: '2026-09-13T12:00:00Z',
                remainingFraction: 1,
              },
              {
                bucketId: '3p-5h',
                displayName: 'Five Hour Limit Remaining',
                window: '5h',
                resetTime: '2026-09-06T17:00:00Z',
                remainingFraction: 1,
              },
            ],
          },
        ],
      },
    );

    expect(snapshot.quotaGroups).toHaveLength(2);
    const gemini = snapshot.models.find((m) => m.label.includes('Gemini'));
    expect(gemini?.remainingPercentage).toBe(0.54);
    expect(gemini?.resetTime).toBe('2026-09-08T12:00:00Z');
    expect(gemini?.timeUntilResetMs).toBe(2 * 24 * 60 * 60 * 1000);
    expect(gemini?.isExhausted).toBe(false);

    const claude = snapshot.models.find((m) => m.label.includes('Claude'));
    expect(claude?.remainingPercentage).toBe(1);
    expect(claude?.resetTime).toBe('2026-09-06T17:00:00Z');
    expect(claude?.timeUntilResetMs).toBe(5 * 60 * 60 * 1000);
  });

  it('marks model as exhausted when 5-hour limit reaches 0 despite weekly remaining quota', () => {
    const nowMs = Date.parse('2026-09-06T15:30:00Z');
    const snapshot = parseSnapshot(
      { paidTier: { name: 'Google AI Pro' } },
      {
        models: {
          'gemini-3.1-pro-high': {
            displayName: 'Gemini 3.1 Pro (High)',
            quotaInfo: { remainingFraction: 1, resetTime: '2026-09-06T18:30:00Z' },
          },
        },
      },
      'bonka@gmail.com',
      nowMs,
      {
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
            buckets: [
              {
                bucketId: 'gemini-weekly',
                displayName: 'Weekly Limit Remaining',
                window: 'weekly',
                resetTime: '2026-09-13T13:30:00Z',
                remainingFraction: 0.83,
              },
              {
                bucketId: 'gemini-5h',
                displayName: 'Five Hour Limit Remaining',
                window: '5h',
                resetTime: '2026-09-06T18:30:00Z',
                remainingFraction: 0,
              },
            ],
          },
        ],
      },
    );

    const model = snapshot.models.find((m) => m.label.includes('Gemini'));
    expect(model).toBeDefined();
    expect(model?.remainingPercentage).toBe(0);
    expect(model?.isExhausted).toBe(true);
    expect(model?.resetTime).toBe('2026-09-06T18:30:00Z');
    expect(model?.timeUntilResetMs).toBe(3 * 60 * 60 * 1000);
  });

  it('defaults CLOUDCODE.baseUrl to daily-cloudcode-pa.googleapis.com', () => {
    expect(CLOUDCODE.baseUrl).toBe('https://daily-cloudcode-pa.googleapis.com');
  });
});

describe('render helpers', () => {
  it('formats durations', () => {
    expect(humanDuration(0)).toBe('now');
    expect(humanDuration(30_000)).toBe('<1m');
    expect(humanDuration(45 * 60_000)).toBe('45m');
    expect(humanDuration(4 * 3_600_000 + 41 * 60_000)).toBe('4h 41m');
    expect(humanDuration(50 * 3_600_000)).toBe('2d 2h');
  });

  it('draws a fixed-width bar and clamps out-of-range input', () => {
    const strip = (s: string) => s.replace(/[^█░]/g, '');
    expect(strip(bar(0.5, 10))).toBe('█████░░░░░');
    expect(strip(bar(-1, 4))).toBe('░░░░');
    expect(strip(bar(2, 4))).toBe('████');
    expect(strip(bar(NaN, 10))).toBe('░░░░░░░░░░');
  });

  it('renders snapshot with quota groups and buckets', () => {
    const snapshot = {
      email: 'user@gmail.com',
      planType: 'Google AI Pro',
      models: [
        { label: 'Gemini 3.1 Pro', modelIds: ['gemini-3.1-pro'], remainingPercentage: 0.54, isExhausted: false, groupName: 'Gemini Models' },
      ],
      quotaGroups: [
        {
          displayName: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            {
              bucketId: 'gemini-weekly',
              displayName: 'Weekly Limit Remaining',
              window: 'weekly',
              remainingFraction: 0.54,
              timeUntilResetMs: 28 * 3600 * 1000,
            },
            {
              bucketId: 'gemini-5h',
              displayName: 'Five Hour Limit Remaining',
              window: '5h',
              remainingFraction: 0.9,
              timeUntilResetMs: 2 * 3600 * 1000,
            },
          ],
        },
      ],
    };

    const rendered = renderSnapshot(snapshot);
    expect(rendered).toContain('user@gmail.com');
    expect(rendered).toContain('Google AI Pro');
    expect(rendered).toContain('Gemini Models');
    expect(rendered).toContain('Weekly Limit Remaining');
    expect(rendered).toContain('54%');
    expect(rendered).toContain('resets in 1d 4h');
    expect(rendered).toContain('Five Hour Limit Remaining');
    expect(rendered).toContain('90%');
    expect(rendered).toContain('resets in 2h');

    // Without showModels, individual group models are not repeated
    expect(rendered).not.toContain('Models:');

    // With showModels, models are listed
    const withModels = renderSnapshot(snapshot, true);
    expect(withModels).toContain('Models:');
    expect(withModels).toContain('Gemini 3.1 Pro');
  });
});
