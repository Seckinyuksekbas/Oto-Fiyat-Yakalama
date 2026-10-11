'use client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminPlanCreate, AdminPlanUpdate, AdminQueueClean, AdminQueueName, SettingKey } from '@oto/shared';
import type { PageQuery } from './admin-api';
import { adminKeys } from './admin-queries';
import { opsApi, type AdminNotificationsQuery, type AuditLogsQuery, type LatencyRange } from './admin-ops-api';

/**
 * Task 12 sorgu anahtarları. Hepsi `'admin'` kökü altındadır (bkz. `adminKeys`); paketler mevcut `adminKeys.plans()`
 * anahtarını paylaşır ki kullanıcı detayındaki paket listesi de tazelensin.
 */
export const opsKeys = {
  queues: () => ['admin', 'queues'] as const,
  workers: () => ['admin', 'workers'] as const,
  latency: (range: LatencyRange) => ['admin', 'latency', range] as const,
  stuck: (q: PageQuery) => ['admin', 'match-dispatches', 'stuck', q] as const,
  stuckAll: ['admin', 'match-dispatches'] as const,
  notifications: (q: AdminNotificationsQuery) => ['admin', 'notifications', q] as const,
  notificationsAll: ['admin', 'notifications'] as const,
  settings: () => ['admin', 'settings'] as const,
  auditLogs: (q: AuditLogsQuery) => ['admin', 'audit-logs', q] as const,
};

/** Kuyruk ve worker durumları canlıdır: 15 sn'de bir, yalnızca sekme görünürken yenilenir. */
const LIVE_MS = 15_000;

export function useAdminQueues() {
  return useQuery({ queryKey: opsKeys.queues(), queryFn: opsApi.queues, refetchInterval: LIVE_MS });
}

export function useAdminWorkers() {
  return useQuery({ queryKey: opsKeys.workers(), queryFn: opsApi.workers, refetchInterval: LIVE_MS });
}

export function useNotificationLatency(range: LatencyRange) {
  return useQuery({
    queryKey: opsKeys.latency(range),
    queryFn: () => opsApi.latency(range),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export function useStuckDispatches(q: PageQuery) {
  return useQuery({ queryKey: opsKeys.stuck(q), queryFn: () => opsApi.stuckDispatches(q), placeholderData: keepPreviousData });
}

function useInvalidate(...keys: ReadonlyArray<readonly unknown[]>) {
  const qc = useQueryClient();
  return () => Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey })));
}

/** Kuyruk eylemleri sonrası: kuyruk sayıları, genel bakış ve (bildirim kuyruklarında) bildirim listesi tazelenir. */
function useQueueInvalidate() {
  return useInvalidate(opsKeys.queues(), adminKeys.overview(), opsKeys.notificationsAll);
}

export function useRetryFailedJobs() {
  const invalidate = useQueueInvalidate();
  return useMutation({ mutationFn: (name: AdminQueueName) => opsApi.retryFailed(name), onSettled: invalidate });
}

export function useCleanQueue() {
  const invalidate = useQueueInvalidate();
  return useMutation({
    mutationFn: ({ name, body }: { name: AdminQueueName; body: AdminQueueClean }) => opsApi.cleanQueue(name, body),
    onSettled: invalidate,
  });
}

export function useResetDispatch() {
  const invalidate = useInvalidate(opsKeys.stuckAll);
  return useMutation({ mutationFn: (analysisId: number) => opsApi.resetDispatch(analysisId), onSettled: invalidate });
}

export function useAdminNotifications(q: AdminNotificationsQuery) {
  return useQuery({ queryKey: opsKeys.notifications(q), queryFn: () => opsApi.notifications(q), placeholderData: keepPreviousData });
}

export function useRetryNotifications() {
  const invalidate = useInvalidate(opsKeys.notificationsAll, opsKeys.queues(), adminKeys.overview());
  return useMutation({ mutationFn: (ids: number[]) => opsApi.retryNotifications(ids), onSettled: invalidate });
}

export type PlanSave = { kind: 'create'; body: AdminPlanCreate } | { kind: 'update'; id: string; body: AdminPlanUpdate };

export function useSavePlan() {
  const invalidate = useInvalidate(adminKeys.plans());
  return useMutation({
    mutationFn: async (s: PlanSave) =>
      s.kind === 'create' ? { ...(await opsApi.createPlan(s.body)), usersOverProfileLimit: 0 } : flatten(await opsApi.updatePlan(s.id, s.body)),
    onSuccess: invalidate,
  });
}

const flatten = (r: Awaited<ReturnType<typeof opsApi.updatePlan>>) => ({ plan: r.plan, usersOverProfileLimit: r.plan.usersOverProfileLimit ?? 0 });

export function useAdminSettings() {
  return useQuery({ queryKey: opsKeys.settings(), queryFn: opsApi.settings });
}

export function usePatchSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: SettingKey; value: Record<string, number | null> }) => opsApi.patchSetting(key, value),
    onSuccess: () => qc.invalidateQueries({ queryKey: opsKeys.settings() }),
  });
}

export function useAuditLogs(q: AuditLogsQuery) {
  return useQuery({ queryKey: opsKeys.auditLogs(q), queryFn: () => opsApi.auditLogs(q), placeholderData: keepPreviousData });
}
