import { describe, expect, it } from 'vitest';
import { analyzeJobSchema, matchJobSchema, QueueName, scrapeJobSchema } from './index';

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
