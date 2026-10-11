'use client';
import { useEffect } from 'react';

/**
 * `next` yalnızca iç yol olabilir: "/" ile başlar, "//" ya da "/\" ile başlamaz.
 * Aksi halde panel ana sayfasına döner (open-redirect koruması).
 */
export function safeNextPath(next: string | null | undefined, fallback = '/app'): string {
  if (typeof next !== 'string' || next.length === 0) return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  // Kontrol karakterleri / satır sonları içeren değerleri reddet
  for (let i = 0; i < next.length; i++) if (next.charCodeAt(i) < 0x20) return fallback;
  return next;
}

type Listener = () => void;
const loggedOutListeners = new Set<Listener>();

/** Çıkışta çalışır (ör. Task 8: closeNotificationStream). Abonelikten çıkış fonksiyonu döner. */
export function onLoggedOut(fn: Listener): () => void {
  loggedOutListeners.add(fn);
  return () => loggedOutListeners.delete(fn);
}

export function emitLoggedOut(): void {
  for (const fn of [...loggedOutListeners]) fn();
}

export function useOnLoggedOut(fn: Listener): void {
  useEffect(() => onLoggedOut(fn), [fn]);
}
