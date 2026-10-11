import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { MatchingModule } from '../src/matching/matching.module';
import { MatchService } from '../src/matching/match.service';
import { createAnalysis, createContext, createListing, createProfile, createSource, createUser, resetState } from './helpers';

let ref: TestingModule;
let prisma: PrismaService;
let sourceId: number;

beforeAll(async () => {
  ref = await createContext([MatchingModule]);
  prisma = ref.get(PrismaService);
});
afterAll(async () => ref.close());
beforeEach(async () => {
  await resetState(ref);
  sourceId = (await createSource(ref, 'http://demo.invalid')).id;
});

const eventAtOf = async () => ((await prisma.notification.findFirstOrThrow()).payload as { eventAt: string }).eventAt;

describe('payload eventAt', () => {
  it('genuine first-seen NEW (first analysis) uses listing.firstSeenAt', async () => {
    const u = await createUser(ref);
    await createProfile(ref, u.id);
    const l = await createListing(ref, sourceId, { price: 960_000n, firstSeenAt: new Date('2026-10-01T10:00:00Z') });
    const a = await createAnalysis(ref, l.id);
    await ref.get(MatchService).process({ listingId: l.id, analysisId: a.id, event: 'NEW' });
    expect(await eventAtOf()).toBe('2026-10-01T10:00:00.000Z');
  });

  it('a NEW promoted by a later REFRESH/CHANGE analysis uses that analysis createdAt', async () => {
    const u = await createUser(ref);
    await createProfile(ref, u.id);
    const l = await createListing(ref, sourceId, { price: 960_000n, firstSeenAt: new Date('2026-10-01T10:00:00Z') });
    await createAnalysis(ref, l.id, { confidence: 'INSUFFICIENT', createdAt: new Date('2026-10-01T10:00:05Z') });
    const later = await createAnalysis(ref, l.id, { createdAt: new Date('2026-10-05T03:00:00Z') });
    await ref.get(MatchService).process({ listingId: l.id, analysisId: later.id, event: 'NEW' });
    expect(await eventAtOf()).toBe('2026-10-05T03:00:00.000Z');
  });
});
