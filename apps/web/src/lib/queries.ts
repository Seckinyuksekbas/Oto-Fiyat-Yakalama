'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './api';
import { emitLoggedOut } from './session';

export const queryKeys = {
  me: ['me'] as const,
};

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  emailVerified?: boolean;
  [key: string]: unknown;
}

export interface MeResponse {
  user: PublicUser;
  subscription?: unknown;
  usage?: { searchProfiles: number; notificationsToday: number };
}

export function useMe() {
  return useQuery({ queryKey: queryKeys.me, queryFn: () => apiFetch<MeResponse>('/me') });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>('/auth/logout', { method: 'POST' }),
    onSettled: () => {
      emitLoggedOut();
      qc.clear();
    },
  });
}
