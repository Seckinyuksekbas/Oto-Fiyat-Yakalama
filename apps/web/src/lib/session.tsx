'use client';
import { useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * `next` yalnızca iç yol olabilir: "/" ile başlar, "//" ya da "/\" ile başlamaz.
 * Yalnızca `/app` ve `/admin` kökleri kabul edilir; aksi halde panel ana sayfasına döner (open-redirect koruması).
 */
export function safeNextPath(next: string | null | undefined, fallback = '/app'): string {
  if (typeof next !== 'string') return fallback;
  if (next.startsWith('//') || next.includes(String.fromCharCode(92))) return fallback;
  for (let i = 0; i < next.length; i++) {
    const c = next.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return fallback;
  }
  const path = next.split(/[?#]/, 1)[0] ?? '';
  const allowed = ['/app', '/admin'].some((root) => path === root || path.startsWith(`${root}/`));
  if (!allowed) return fallback;
  if (path.split('/').includes('..')) return fallback;
  return next;
}

const RETRY_FLAG = '_r';

/** Başarılı refresh sonrası yönlendirmede tek seferlik döngü korumasını işaretler. */
export function withRetryFlag(path: string): string {
  const hashAt = path.indexOf('#');
  const hash = hashAt >= 0 ? path.slice(hashAt) : '';
  const base = hashAt >= 0 ? path.slice(0, hashAt) : path;
  return `${base}${base.includes('?') ? '&' : '?'}${RETRY_FLAG}=1${hash}`;
}

export function stripRetryFlag(path: string): string {
  const u = new URL(path, 'http://x');
  u.searchParams.delete(RETRY_FLAG);
  return u.pathname + u.search + u.hash;
}

/** Sayfa yüklendikten sonra `_r` işaretini adres çubuğundan siler. */
export function stripRetryFlagFromLocation(): void {
  const cur = window.location.pathname + window.location.search + window.location.hash;
  if (!new URLSearchParams(window.location.search).has(RETRY_FLAG)) return;
  window.history.replaceState(window.history.state, '', stripRetryFlag(cur));
}

/** Panel düzeninde: adres çubuğundaki `_r` işaretini (gezinme sonrası da) siler. */
export function RetryFlagStripper(): null {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const has = params.has(RETRY_FLAG);
  useEffect(() => {
    if (!has) return;
    const next = new URLSearchParams(params.toString());
    next.delete(RETRY_FLAG);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [has, pathname]);
  return null;
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
