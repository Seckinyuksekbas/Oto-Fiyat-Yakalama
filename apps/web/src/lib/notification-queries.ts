'use client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiFetch } from './api';
import type { NotificationView } from './notification-text';
import { NOTIFICATION_KEYS } from './sse';

export interface NotificationsPage {
  items: NotificationView[];
  nextCursor: number | null;
  unreadCount: number;
}

export interface NotificationFilters {
  unread?: boolean;
  channel?: 'IN_APP' | 'TELEGRAM';
  status?: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED_LIMIT';
}

function toQuery(f: NotificationFilters) {
  return { unread: f.unread ? 'true' : undefined, channel: f.channel, status: f.status };
}

/** Akış `ready` olayı sayacı yazar; akıştan önce ya da akışsız sayfalarda bir kez çekilir. */
export function useUnreadCount() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: NOTIFICATION_KEYS.unread,
    queryFn: async () => {
      const fetched = (await apiFetch<NotificationsPage>('/me/notifications', { query: { limit: 1 } })).unreadCount;
      // Akış bu arada `ready` ile daha taze bir değer yazdıysa onu ezme.
      return qc.getQueryData<number>(NOTIFICATION_KEYS.unread) ?? fetched;
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/** Zil paneli: son 10 uygulama içi bildirim. */
export function useRecentNotifications(enabled: boolean) {
  return useQuery({
    queryKey: [...NOTIFICATION_KEYS.list, 'recent'],
    queryFn: () => apiFetch<NotificationsPage>('/me/notifications', { query: { limit: 10, channel: 'IN_APP' } }),
    enabled,
  });
}

export function useNotificationsInfinite(filters: NotificationFilters) {
  return useInfiniteQuery({
    queryKey: [...NOTIFICATION_KEYS.list, 'infinite', filters],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      apiFetch<NotificationsPage>('/me/notifications', { query: { limit: 20, cursor: pageParam, ...toQuery(filters) } }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export type MarkReadInput = { all: true } | { ids: number[] };

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MarkReadInput) =>
      apiFetch<{ updated: number }>('/me/notifications/read', { method: 'POST', json: input }),
    onMutate: (input) => {
      const prev = qc.getQueryData<number>(NOTIFICATION_KEYS.unread);
      if ('all' in input) qc.setQueryData<number>(NOTIFICATION_KEYS.unread, 0);
      else qc.setQueryData<number>(NOTIFICATION_KEYS.unread, (c) => Math.max(0, (c ?? 0) - input.ids.length));
      return { prev };
    },
    onError: (_err, _input, ctx) => {
      qc.setQueryData<number | undefined>(NOTIFICATION_KEYS.unread, ctx?.prev);
      toast.error('Okundu olarak işaretlenemedi. Bir süre sonra yeniden deneyin.');
    },
    onSuccess: (res, input, ctx) => {
      if ('all' in input) qc.setQueryData<number>(NOTIFICATION_KEYS.unread, 0);
      else if (ctx?.prev !== undefined) qc.setQueryData<number>(NOTIFICATION_KEYS.unread, Math.max(0, ctx.prev - res.updated));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: NOTIFICATION_KEYS.list });
    },
  });
}
