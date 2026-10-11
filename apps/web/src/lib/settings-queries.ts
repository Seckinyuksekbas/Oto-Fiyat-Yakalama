'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SubscriptionView } from '@oto/shared';
import { apiFetch } from './api';
import { queryKeys } from './queries';
import { emitLoggedOut } from './session';

export interface SessionItem {
  id: string;
  ip: string | null;
  userAgent: string | null;
  lastUsedAt: string;
  current: boolean;
}

export interface ChannelItem {
  type: 'IN_APP' | 'TELEGRAM';
  linked?: boolean;
  isVerified: boolean;
  isEnabled: boolean;
}

export interface ChannelsResponse {
  items: ChannelItem[];
  telegramAvailable: boolean;
}

export interface TelegramLink {
  deepLink: string;
  expiresAt: string;
}

export const settingsKeys = {
  subscription: ['subscription'] as const,
  sessions: ['sessions'] as const,
  channels: ['channels'] as const,
};

export function useSubscription() {
  return useQuery({ queryKey: settingsKeys.subscription, queryFn: () => apiFetch<SubscriptionView>('/me/subscription') });
}

export function useUpdateName() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => apiFetch<unknown>('/me', { method: 'PATCH', json: { name } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.me }),
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      apiFetch<void>('/me/change-password', { method: 'POST', json: input }),
  });
}

export function useSessions() {
  return useQuery({
    queryKey: settingsKeys.sessions,
    queryFn: () => apiFetch<{ items: SessionItem[] }>('/me/sessions'),
  });
}

export class RevokeSessionsError extends Error {
  readonly failed: number;
  constructor(failed: number) {
    super(`${failed} oturum kapatilamadi`);
    this.name = 'RevokeSessionsError';
    this.failed = failed;
  }
}

export function useRevokeSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((id) => apiFetch<void>(`/me/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })),
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) throw new RevokeSessionsError(failed);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: settingsKeys.sessions }),
  });
}

export function useDeleteAccount() {
  return useMutation({
    mutationFn: (password: string) => apiFetch<void>('/me', { method: 'DELETE', json: { password } }),
  });
}

/** Hesap silindikten sonra: önce yönlendirin, sonra bunu çağırın (açık sayfa boş veriyle yeniden çizilmesin). */
export function usePurgeSession() {
  const qc = useQueryClient();
  return async () => {
    emitLoggedOut();
    await qc.cancelQueries();
    qc.clear();
  };
}

/** `pollMs` verilirse kanal listesi o aralıkla yoklanır (Telegram bağlama beklemesi). */
export function useChannels(pollMs?: number) {
  return useQuery({
    queryKey: settingsKeys.channels,
    queryFn: () => apiFetch<ChannelsResponse>('/me/channels'),
    refetchInterval: pollMs ?? false,
  });
}

export function useLinkTelegram() {
  return useMutation({ mutationFn: () => apiFetch<TelegramLink>('/me/channels/telegram/link', { method: 'POST' }) });
}

export function usePatchChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { type: 'TELEGRAM'; isEnabled: boolean }) =>
      apiFetch<unknown>(`/me/channels/${v.type}`, { method: 'PATCH', json: { isEnabled: v.isEnabled } }),
    onSettled: () => qc.invalidateQueries({ queryKey: settingsKeys.channels }),
  });
}

export function useUnlinkTelegram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>('/me/channels/telegram', { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: settingsKeys.channels }),
  });
}
