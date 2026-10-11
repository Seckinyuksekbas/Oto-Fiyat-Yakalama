import { describe, expect, it } from 'vitest';
import {
  adminAnalysesQuerySchema,
  adminAuditLogsQuerySchema,
  adminJobsQuerySchema,
  adminListingIssuesQuerySchema,
  adminListingsQuerySchema,
  adminNotificationRetrySchema,
  adminNotificationsQuerySchema,
  adminPlanCreateSchema,
  adminProxyCreateSchema,
  adminQueueCleanSchema,
  adminQueueNameSchema,
  adminSettingsPatchSchema,
  adminSourceCreateSchema,
  adminSubscriptionSchema,
  adminSystemLogsQuerySchema,
  adminUsersQuerySchema,
  escapeLike,
  maskUrlQuery,
  parseSettingValue,
} from './index';

describe('escapeLike / maskUrlQuery', () => {
  it('escapes LIKE metacharacters', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    expect(escapeLike('plain')).toBe('plain');
  });
  it('masks url query', () => {
    expect(maskUrlQuery('https://a/b?x=1')).toBe('https://a/b?…');
    expect(maskUrlQuery('https://a/b')).toBe('https://a/b');
    expect(maskUrlQuery('not a url')).toBe('[geçersiz URL]');
    expect(maskUrlQuery('https://u:p@a/b?x=1')).toBe('https://a/b?…');
    expect(maskUrlQuery('https://a/b#frag')).toBe('https://a/b');
    expect(maskUrlQuery('https://a/b?')).toBe('https://a/b');
    expect(maskUrlQuery('ftp://a/b?x=1')).toBe('[geçersiz URL]');
    expect(maskUrlQuery('javascript:alert(1)')).toBe('[geçersiz URL]');
  });
});

describe('admin query schemas', () => {
  const all = [
    adminUsersQuerySchema,
    adminListingsQuerySchema,
    adminListingIssuesQuerySchema,
    adminAnalysesQuerySchema,
    adminJobsQuerySchema,
    adminNotificationsQuerySchema,
    adminAuditLogsQuerySchema,
    adminSystemLogsQuerySchema,
  ];
  it.each(all.map((s, i) => [i, s] as const))('schema %i: defaults, strict, pageSize bound', (_i, s) => {
    expect(s.parse({})).toMatchObject({ page: 1, pageSize: 20 });
    expect(s.safeParse({ pageSize: '101' }).success).toBe(false);
    expect(s.safeParse({ pageSize: '0' }).success).toBe(false);
    expect(s.safeParse({ page: '0' }).success).toBe(false);
    expect(s.safeParse({ bogus: 1 }).success).toBe(false);
    expect(s.parse({ pageSize: '100' }).pageSize).toBe(100);
  });
  it('specific filters', () => {
    expect(adminUsersQuerySchema.parse({ plan: 'PRO' }).plan).toBe('PRO');
    expect(adminListingsQuerySchema.parse({ source: '2', hasIssues: 'true', status: 'REMOVED' })).toMatchObject({
      source: 2,
      hasIssues: 'true',
    });
    expect(adminListingsQuerySchema.safeParse({ status: 'X' }).success).toBe(false);
    expect(adminAnalysesQuerySchema.safeParse({ minScore: '101' }).success).toBe(false);
    expect(adminJobsQuerySchema.safeParse({ status: 'PARTIAL', trigger: 'MANUAL' }).success).toBe(true);
    expect(adminAuditLogsQuerySchema.safeParse({ from: 'yesterday' }).success).toBe(false);
    expect(adminSystemLogsQuerySchema.safeParse({ level: 'DEBUG' }).success).toBe(false);
    expect(adminSystemLogsQuerySchema.safeParse({ level: 'INFO' }).success).toBe(false);
    expect(
      adminSystemLogsQuerySchema.safeParse({ from: '2026-10-11T00:00:00.000Z', level: 'WARN' }).success,
    ).toBe(true);
  });
});

describe('admin body schemas', () => {
  const limits = {
    maxSearchProfiles: 3,
    maxNotificationsPerDay: 20,
    channels: ['IN_APP', 'TELEGRAM'],
    opportunitiesDelayHours: 0,
  };
  it('plan create requires IN_APP and valid code', () => {
    const base = { code: 'PRO', name: 'Pro', priceMonthly: 10, isActive: true, limits };
    expect(adminPlanCreateSchema.safeParse(base).success).toBe(true);
    expect(
      adminPlanCreateSchema.safeParse({ ...base, limits: { ...limits, channels: ['TELEGRAM'] } }).success,
    ).toBe(false);
    expect(adminPlanCreateSchema.safeParse({ ...base, code: 'pro' }).success).toBe(false);
    expect(adminPlanCreateSchema.safeParse({ ...base, priceMonthly: -1 }).success).toBe(false);
  });
  it('subscription override cannot drop IN_APP', () => {
    const ok = { planId: 'p1', endsAt: null, limitOverrides: null };
    expect(adminSubscriptionSchema.safeParse(ok).success).toBe(true);
    expect(adminSubscriptionSchema.safeParse({ ...ok, limitOverrides: { maxSearchProfiles: 9 } }).success).toBe(true);
    expect(adminSubscriptionSchema.safeParse({ ...ok, limitOverrides: { channels: ['TELEGRAM'] } }).success).toBe(false);
    expect(
      adminSubscriptionSchema.safeParse({ ...ok, limitOverrides: { channels: ['IN_APP', 'TELEGRAM'] } }).success,
    ).toBe(true);
    expect(adminSubscriptionSchema.safeParse({ ...ok, endsAt: 'nope' }).success).toBe(false);
  });
  const src = {
    code: 'demo-site',
    name: 'Demo',
    adapterKey: 'demo',
    kind: 'HTTP',
    permissionType: 'TEST',
    permissionNote: 'test',
    intervalSec: 300,
    maxConcurrency: 1,
    minRequestGapMs: 1000,
    config: { baseUrl: 'http://127.0.0.1:4010', extra: 1 },
    proxyConfigId: null,
  };
  it('source create validation', () => {
    expect(adminSourceCreateSchema.safeParse(src).success).toBe(true);
    expect(adminSourceCreateSchema.safeParse({ ...src, code: 'A' }).success).toBe(false);
    expect(adminSourceCreateSchema.safeParse({ ...src, config: { baseUrl: 'ftp://x' } }).success).toBe(false);
    expect(adminSourceCreateSchema.safeParse({ ...src, config: { baseUrl: 'nope' } }).success).toBe(false);
    expect(
      adminSourceCreateSchema.safeParse({ ...src, config: { baseUrl: 'https://a.b', blob: 'x'.repeat(5000) } }).success,
    ).toBe(false);
    expect(
      adminSourceCreateSchema.safeParse({ ...src, config: { baseUrl: 'https://a.b', blob: 'ğ'.repeat(2100) } }).success,
    ).toBe(false);
    expect(adminSourceCreateSchema.safeParse({ ...src, intervalSec: 10 }).success).toBe(false);
    expect(adminSourceCreateSchema.safeParse({ ...src, permissionNote: 'x'.repeat(501) }).success).toBe(false);
  });
  it('proxy, queue, retry', () => {
    expect(adminProxyCreateSchema.safeParse({ name: 'p', url: 'http://u:p@h:8080', isEnabled: true }).success).toBe(true);
    expect(adminProxyCreateSchema.safeParse({ name: 'p', url: 'socks5://h:1', isEnabled: true }).success).toBe(false);
    expect(adminQueueNameSchema.safeParse('notify-telegram').success).toBe(true);
    expect(adminQueueNameSchema.safeParse('other').success).toBe(false);
    expect(adminQueueCleanSchema.safeParse({ state: 'failed', olderThanSec: 3599 }).success).toBe(false);
    expect(adminQueueCleanSchema.safeParse({ state: 'completed', olderThanSec: 3600 }).success).toBe(true);
    expect(adminNotificationRetrySchema.safeParse({ ids: [] }).success).toBe(false);
    expect(
      adminNotificationRetrySchema.safeParse({ ids: Array.from({ length: 101 }, (_, i) => i + 1) }).success,
    ).toBe(false);
    expect(adminNotificationRetrySchema.safeParse({ ids: [1, 2] }).success).toBe(true);
  });
});

describe('settings', () => {
  it('patch envelope', () => {
    expect(adminSettingsPatchSchema.safeParse({ key: 'nope', value: {} }).success).toBe(false);
    expect(adminSettingsPatchSchema.safeParse({ key: 'analysis.settings', value: { a: 1 } }).success).toBe(true);
  });
  it('analysis settings: partial, strict, cross-field', () => {
    expect(parseSettingValue('analysis.settings', { minComparables: 6 })).toEqual({
      ok: true,
      value: { minComparables: 6 },
    });
    expect(parseSettingValue('analysis.settings', { minComparables: 10 }).ok).toBe(false); // smallPoolMax(7) < 10
    expect(
      parseSettingValue('analysis.settings', { minComparables: 10, smallPoolMax: 12, theilSenMinPool: 12 }).ok,
    ).toBe(true);
    expect(parseSettingValue('analysis.settings', { smallPoolMax: 3 }).ok).toBe(false);
    expect(parseSettingValue('analysis.settings', { theilSenMinPool: 4 }).ok).toBe(false);
    expect(parseSettingValue('analysis.settings', { bogus: 1 }).ok).toBe(false);
    expect(parseSettingValue('analysis.settings', { yearAdjPct: 'x' }).ok).toBe(false);
    const bad = parseSettingValue('analysis.settings', { smallPoolMax: 3 });
    expect(bad.ok === false && bad.issues[0]?.path).toEqual(['smallPoolMax']);
  });
  it('alerts thresholds', () => {
    expect(parseSettingValue('alerts.thresholds', { notifyFailureRate: 0.2 }).ok).toBe(true);
    expect(parseSettingValue('alerts.thresholds', { notifyFailureRate: 2 }).ok).toBe(false);
    expect(parseSettingValue('alerts.thresholds', { x: 1 }).ok).toBe(false);
  });
});
