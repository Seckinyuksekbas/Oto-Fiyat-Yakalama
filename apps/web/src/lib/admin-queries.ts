'use client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminAlertEvent, AdminSubscription } from '@oto/shared';
import {
  adminApi,
  isAdminRole,
  type AdminRole,
  type AdminUsersQuery,
  type PageQuery,
  type SystemLogItem,
} from './admin-api';
import { useMe } from './queries';

/**
 * Admin sorgu anahtarları. KURAL: her admin sorgusu `'admin'` kökü ile başlar; böylece çıkışta/rol değişiminde
 * `qc.removeQueries({ queryKey: adminKeys.all })` tümünü temizler ve kullanıcı paneli kökleriyle
 * (`favorites`, `opportunities`, `listing`, `dashboard`) asla çakışmaz.
 *
 * Task 11–12: yeni alanlar burada ikinci seviye kökle eklenir (`['admin','sources',…]`, `['admin','jobs',…]` …).
 * `useAdminStream` `job` olayında `adminKeys.jobs.all` ve `adminKeys.sources.all` köklerini geçersiz kılar.
 */
export const adminKeys = {
  all: ['admin'] as const,
  overview: () => ['admin', 'overview'] as const,
  /** Akıştan gelen canlı alarmlar (yalnızca istemci önbelleği). */
  liveAlerts: () => ['admin', 'alerts', 'live'] as const,
  systemLogs: (q: object) => ['admin', 'system-logs', q] as const,
  plans: () => ['admin', 'plans'] as const,
  users: {
    all: ['admin', 'users'] as const,
    list: (q: AdminUsersQuery) => ['admin', 'users', 'list', q] as const,
    detail: (id: string) => ['admin', 'users', 'detail', id] as const,
    usage: (id: string) => ['admin', 'users', 'usage', id] as const,
    profiles: (id: string) => ['admin', 'users', 'profiles', id] as const,
    notifications: (id: string, q: PageQuery) => ['admin', 'users', 'notifications', id, q] as const,
  },
  jobs: { all: ['admin', 'jobs'] as const },
  sources: { all: ['admin', 'sources'] as const },
};

// ---------------------------------------------------------------- rol

export interface AdminRoleState {
  isPending: boolean;
  isError: boolean;
  role: AdminRole | undefined;
  /** ADMIN veya SUPER_ADMIN */
  isAdmin: boolean;
  isSuperAdmin: boolean;
  userId: string | undefined;
}

/** `/me` üzerinden rol. Yalnızca görünürlük içindir; yetki API'de her istekte denetlenir. */
export function useAdminRole(): AdminRoleState {
  const me = useMe();
  const role = me.data?.user.role;
  return {
    isPending: me.isPending,
    isError: me.isError,
    role,
    isAdmin: isAdminRole(role),
    isSuperAdmin: role === 'SUPER_ADMIN',
    userId: me.data?.user.id,
  };
}

// ---------------------------------------------------------------- genel bakış ve alarmlar

export function useAdminOverview() {
  return useQuery({ queryKey: adminKeys.overview(), queryFn: adminApi.overview, staleTime: 30_000 });
}

export interface AlertItem {
  id: string;
  level: 'WARN' | 'ERROR';
  message: string;
  at: string;
  /** `live`: bu oturumda akıştan geldi; `log`: SystemLog'dan yüklendi */
  origin: 'live' | 'log';
  component?: string;
}

export const MAX_LIVE_ALERTS = 50;

export function alertId(a: Pick<AdminAlertEvent, 'key' | 'at'>): string {
  return `${a.key}@${a.at}`;
}

/** Akış alarmını canlı listenin başına ekler (id ile tekil, en fazla 50). */
export function prependLiveAlert(list: AlertItem[] | undefined, a: AdminAlertEvent): AlertItem[] {
  const id = alertId(a);
  const prev = list ?? [];
  if (prev.some((x) => x.id === id)) return prev;
  return [{ id, level: a.level, message: a.message, at: a.at, origin: 'live' as const }, ...prev].slice(0, MAX_LIVE_ALERTS);
}

const SAME_ALERT_WINDOW_MS = 60_000;

/** Canlı alarmlar + SystemLog kayıtları; alarm aynı zamanda SystemLog'a yazıldığından yakın zamanlı kopyalar elenir. */
export function mergeAlerts(live: AlertItem[], logs: SystemLogItem[], limit: number): AlertItem[] {
  const fromLogs: AlertItem[] = logs
    .map((l) => ({ id: `log-${l.id}`, level: l.level, message: l.message, at: l.createdAt, origin: 'log' as const, component: l.component }))
    .filter(
      (l) =>
        !live.some(
          (a) => a.message === l.message && a.level === l.level && Math.abs(Date.parse(a.at) - Date.parse(l.at)) < SAME_ALERT_WINDOW_MS,
        ),
    );
  return [...live, ...fromLogs].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}

/** Genel bakıştaki "Son alarmlar": son SystemLog kayıtlarıyla tohumlanır, akıştan gelen alarmlar anında başa eklenir. */
export function useRecentAlerts(limit = 8) {
  const q = { page: 1, pageSize: limit };
  const logs = useQuery({ queryKey: adminKeys.systemLogs(q), queryFn: () => adminApi.systemLogs(q), staleTime: 60_000 });
  const live = useQuery<AlertItem[]>({
    queryKey: adminKeys.liveAlerts(),
    queryFn: () => [],
    initialData: [],
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return {
    items: mergeAlerts(live.data, logs.data?.items ?? [], limit),
    isPending: logs.isPending,
    isError: logs.isError,
    refetch: logs.refetch,
  };
}

// ---------------------------------------------------------------- paketler

export function useAdminPlans() {
  return useQuery({ queryKey: adminKeys.plans(), queryFn: adminApi.plans, staleTime: 5 * 60_000 });
}

// ---------------------------------------------------------------- kullanıcılar

export function useAdminUsers(q: AdminUsersQuery) {
  return useQuery({
    queryKey: adminKeys.users.list(q),
    queryFn: () => adminApi.users.list(q),
    placeholderData: keepPreviousData,
  });
}

export function useAdminUser(id: string) {
  return useQuery({ queryKey: adminKeys.users.detail(id), queryFn: () => adminApi.users.get(id) });
}

export function useAdminUserUsage(id: string) {
  return useQuery({ queryKey: adminKeys.users.usage(id), queryFn: () => adminApi.users.usage(id) });
}

export function useAdminUserProfiles(id: string) {
  return useQuery({ queryKey: adminKeys.users.profiles(id), queryFn: () => adminApi.users.searchProfiles(id) });
}

export function useAdminUserNotifications(id: string, q: PageQuery) {
  return useQuery({
    queryKey: adminKeys.users.notifications(id, q),
    queryFn: () => adminApi.users.notifications(id, q),
    placeholderData: keepPreviousData,
  });
}

/** Kullanıcı mutasyonu sonrası: kullanıcılar kökü ve genel bakış sayıları tazelenir. */
function useInvalidateUsers() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: adminKeys.users.all }),
      qc.invalidateQueries({ queryKey: adminKeys.overview() }),
    ]);
}

export type UserAction =
  | { kind: 'suspend' }
  | { kind: 'activate' }
  | { kind: 'role'; role: AdminRole }
  | { kind: 'delete' }
  | { kind: 'rename'; name: string };

export function useAdminUserAction(id: string) {
  const invalidate = useInvalidateUsers();
  return useMutation({
    mutationFn: (a: UserAction) => {
      switch (a.kind) {
        case 'suspend':
          return adminApi.users.suspend(id);
        case 'activate':
          return adminApi.users.activate(id);
        case 'role':
          return adminApi.users.setRole(id, a.role);
        case 'delete':
          return adminApi.users.remove(id);
        case 'rename':
          return adminApi.users.rename(id, a.name);
      }
    },
    onSettled: invalidate,
  });
}

export function useAdminSetSubscription(id: string) {
  const invalidate = useInvalidateUsers();
  return useMutation({
    mutationFn: (body: AdminSubscription) => adminApi.users.setSubscription(id, body),
    onSuccess: invalidate,
  });
}
