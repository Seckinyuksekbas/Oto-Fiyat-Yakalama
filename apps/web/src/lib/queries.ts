'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Dashboard } from '@oto/shared';
import { apiFetch } from './api';
import { emitLoggedOut } from './session';

export const queryKeys = {
  me: ['me'] as const,
  dashboard: ['dashboard'] as const,
};

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  emailVerifiedAt?: string | null;
  [key: string]: unknown;
}

export interface MeResponse {
  user: PublicUser;
  subscription?: { planCode: string; planName: string; status: string; endsAt: string | null };
  usage?: { searchProfiles: number; notificationsToday: number };
}

export function useMe() {
  return useQuery({ queryKey: queryKeys.me, queryFn: () => apiFetch<MeResponse>('/me') });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>('/auth/logout', { method: 'POST' }),
    // Oturum kapanırken uçuştaki /me istekleri 401 → refresh → yönlendirme zinciri başlatmasın.
    onMutate: () => qc.cancelQueries(),
    onSettled: async () => {
      emitLoggedOut();
      await qc.cancelQueries();
      qc.clear();
    },
  });
}

export function useDashboard() {
  return useQuery({ queryKey: queryKeys.dashboard, queryFn: () => apiFetch<Dashboard>('/me/dashboard') });
}

export function useResendVerification() {
  return useMutation({
    mutationFn: (email: string) => apiFetch<void>('/auth/resend-verification', { method: 'POST', json: { email } }),
  });
}
