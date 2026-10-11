import { describe, expect, it } from 'vitest';
import { alertDedupeKey, analyzeJobSchema, matchJobSchema, QueueName, SCRAPE_JOB_OPTS, scrapeJobSchema, SETTINGS_CHANGED_CHANNEL } from './index';

describe('shared seams (API + worker)', () => {
  it('scrape job retention: completed 24 h, failed 7 days', () => {
    expect(SCRAPE_JOB_OPTS).toEqual({ removeOnComplete: { age: 86_400 }, removeOnFail: { age: 604_800 } });
  });

  it('settings channel and alert dedupe key format', () => {
    expect(SETTINGS_CHANGED_CHANNEL).toBe('settings:changed');
    expect(alertDedupeKey('match-dispatch-stuck:7')).toBe('alert:match-dispatch-stuck:7');
  });
});

describe('queue contracts', () => {
  it('names queues without colons (BullMQ restriction)', () => {
    for (const name of Object.values(QueueName)) expect(name).not.toContain(':');
  });

  it('validates scrape job data', () => {
    expect(scrapeJobSchema.parse({ collectionJobId: 3, sourceId: 1 })).toEqual({ collectionJobId: 3, sourceId: 1 });
    expect(scrapeJobSchema.safeParse({ collectionJobId: 0, sourceId: 1 }).success).toBe(false);
  });

  it('carries money as a digit string, never a number', () => {
    expect(analyzeJobSchema.safeParse({ listingId: 1, reason: 'PRICE_CHANGE', previousPrice: '960000' }).success).toBe(true);
    expect(analyzeJobSchema.safeParse({ listingId: 1, reason: 'PRICE_CHANGE', previousPrice: 960000 }).success).toBe(false);
    expect(analyzeJobSchema.safeParse({ listingId: 1, reason: 'NOPE' }).success).toBe(false);
  });

  it('accepts REFRESH for analyze and validates match jobs', () => {
    expect(analyzeJobSchema.safeParse({ listingId: 1, reason: 'REFRESH' }).success).toBe(true);
    expect(QueueName.MATCH).toBe('match');
    expect(matchJobSchema.parse({ listingId: 1, analysisId: 2, event: 'PRICE_DROP', previousPrice: '960000' })).toEqual({ listingId: 1, analysisId: 2, event: 'PRICE_DROP', previousPrice: '960000' });
    expect(matchJobSchema.safeParse({ listingId: 1, analysisId: 2, event: 'CHANGE' }).success).toBe(false);
  });
});

describe('matchJobSchema negative cases', () => {
  it('rejects numeric previousPrice and non-positive ids', () => {
    expect(matchJobSchema.safeParse({ listingId: 1, analysisId: 1, event: 'PRICE_DROP', previousPrice: 1000 }).success).toBe(false);
    expect(matchJobSchema.safeParse({ listingId: 1, analysisId: 0, event: 'NEW' }).success).toBe(false);
    expect(matchJobSchema.safeParse({ listingId: -1, analysisId: 1, event: 'NEW' }).success).toBe(false);
    expect(matchJobSchema.safeParse({ listingId: 1, analysisId: 1, event: 'REFRESH' }).success).toBe(false);
  });
});
