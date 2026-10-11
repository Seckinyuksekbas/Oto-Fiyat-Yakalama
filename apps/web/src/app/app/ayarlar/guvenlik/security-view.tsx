'use client';
import { useState, type FormEvent } from 'react';
import { Laptop, Smartphone } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { maskIp, shortUserAgent } from '@/lib/device';
import { formatRelative } from '@/lib/format';
import { NETWORK_MESSAGE, RATE_LIMIT_MESSAGE, apiErrorMessage } from '@/lib/messages';
import { RevokeSessionsError, useChangePassword, useRevokeSessions, useSessions } from '@/lib/settings-queries';

function passwordErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429 || err.code === 'RATE_LIMITED') return RATE_LIMIT_MESSAGE;
    if (err.code === 'INVALID_CREDENTIALS') return 'Mevcut şifre hatalı';
    return apiErrorMessage(err);
  }
  return NETWORK_MESSAGE;
}

function PasswordForm() {
  const change = useChangePassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [local, setLocal] = useState<{ field: 'current' | 'next'; msg: string } | null>(null);
  const [done, setDone] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setDone(false);
    if (!current) return setLocal({ field: 'current', msg: 'Mevcut şifrenizi girin' });
    if (next.length < 10) return setLocal({ field: 'next', msg: 'En az 10 karakter olmalı' });
    setLocal(null);
    change.mutate(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: () => {
          setCurrent('');
          setNext('');
          setDone(true);
        },
      },
    );
  };

  const serverError = change.isError ? passwordErrorMessage(change.error) : null;

  return (
    <Card className="p-6">
      <form onSubmit={submit} noValidate className="grid gap-5">
        <div>
          <h2 className="font-display text-lg font-semibold">Şifre</h2>
          <p className="text-sm text-muted">Şifre değişince bu cihaz dışındaki tüm oturumlar kapatılır.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pw-cur">Mevcut şifre</Label>
          <Input
            id="pw-cur"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            aria-invalid={local?.field === 'current' ? true : undefined}
          />
          {local?.field === 'current' ? (
            <p role="alert" className="text-sm text-danger-text">
              {local.msg}
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pw-new">Yeni şifre</Label>
          <Input
            id="pw-new"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            aria-describedby="pw-hint"
            aria-invalid={local?.field === 'next' ? true : undefined}
          />
          <p id="pw-hint" className="text-xs text-muted">
            En az 10 karakter. Daha önce sızdırılmış şifreler kabul edilmez.
          </p>
          {local?.field === 'next' ? (
            <p role="alert" className="text-sm text-danger-text">
              {local.msg}
            </p>
          ) : null}
        </div>
        <div aria-live="polite">
          {serverError ? (
            <p role="alert" className="text-sm text-danger-text">
              {serverError}
            </p>
          ) : null}
          {done ? (
            <p className="text-sm text-positive-text">
              Şifreniz değiştirildi; diğer oturumlarınız kapatıldı.
            </p>
          ) : null}
        </div>
        <div>
          <Button type="submit" disabled={change.isPending}>
            Şifreyi değiştir
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Sessions() {
  const q = useSessions();
  const revoke = useRevokeSessions();
  const items = q.data?.items ?? [];
  const others = items.filter((s) => !s.current);

  return (
    <Card className="p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold">Oturumlar</h2>
          <p className="text-sm text-muted">Hesabınıza giriş yapılmış cihazlar. Tanımadığınız oturumu kapatın.</p>
        </div>
        {others.length > 0 ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate(others.map((s) => s.id))}
          >
            Diğer oturumları kapat
          </Button>
        ) : null}
      </div>
      {q.isPending ? (
        <Skeleton className="h-20 w-full" aria-busy="true" />
      ) : q.isError ? (
        <p role="alert" className="text-sm text-danger-text">
          Oturumlar yüklenemedi.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((s) => {
            const label = shortUserAgent(s.userAgent);
            const Icon = /iOS|Android/.test(label) ? Smartphone : Laptop;
            return (
              <li key={s.id} className="flex items-center gap-3 py-3">
                <Icon aria-hidden className="size-5 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {label}
                    {s.current ? <Badge tone="accent">Bu cihaz</Badge> : null}
                  </p>
                  <p className="text-xs text-muted">
                    <span className="font-mono">{maskIp(s.ip)}</span> · Son kullanım {formatRelative(s.lastUsedAt)}
                  </p>
                </div>
                {s.current ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={revoke.isPending}
                    aria-label={`Oturumu kapat: ${label}`}
                    onClick={() => revoke.mutate([s.id])}
                  >
                    Oturumu kapat
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {revoke.isError ? (
        <p role="alert" className="mt-3 text-sm text-danger-text">
          {revoke.error instanceof RevokeSessionsError
            ? `${revoke.error.failed} oturum kapatılamadı. Tekrar deneyin.`
            : apiErrorMessage(revoke.error)}
        </p>
      ) : null}
    </Card>
  );
}

export function SecurityView() {
  return (
    <div className="space-y-6">
      <PasswordForm />
      <Sessions />
    </div>
  );
}
