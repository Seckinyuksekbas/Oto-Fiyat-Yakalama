'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { loginSchema, type LoginInput } from '@oto/shared';
import { Button } from '@/components/ui/button';
import { apiFetch, refreshSession } from '@/lib/api';
import { apiErrorMessage, trErrorMap } from '@/lib/messages';
import { safeNextPath, withRetryFlag } from '@/lib/session';
import { authLinkClass, Field, FormError, Heading } from '../_components/form-bits';

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNextPath(params.get('next'));
  const [checking, setChecking] = useState(params.get('try_refresh') === '1');
  const reason = params.get('reason');
  const reasonMessage =
    reason === 'reused'
      ? 'Oturumunuz güvenlik nedeniyle sonlandırıldı. Lütfen tekrar giriş yapın.'
      : reason === 'failed'
        ? 'Oturum açılamadı, lütfen tekrar giriş yapın.'
        : null;

  // Zaten girişli kullanıcı: yalnızca /me başarılı olunca yönlendir (yenileme denenmez).
  // Kendi anahtarı ve gcTime 0: ortak ['me'] önbelleğindeki bayat başarı (ör. çıkıştan hemen sonra) yönlendirmez;
  // yalnızca bu bileşen bağlandıktan sonra yapılan taze istek başarılıysa yönlendirilir.
  const session = useQuery({
    queryKey: ['session-check'],
    queryFn: () => apiFetch('/me', { noRefresh: true }),
    enabled: !checking,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const signedIn = session.isFetchedAfterMount && session.isSuccess;
  useEffect(() => {
    if (signedIn) router.replace(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  useEffect(() => {
    if (!checking) return;
    let cancelled = false;
    void refreshSession().then((ok) => {
      if (cancelled) return;
      // Sert gezinme: `_r` yalnızca bu tek yüklemede bulunur, istemci yönlendirmeleriyle kalıcı olmaz.
      if (ok) window.location.replace(withRetryFlag(next));
      else setChecking(false);
    });
    return () => {
      cancelled = true;
    };
    // yalnızca ilk yüklemede
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema, { errorMap: trErrorMap }),
    defaultValues: { email: '', password: '' },
  });

  const login = useMutation({
    mutationFn: (input: LoginInput) => apiFetch('/auth/login', { method: 'POST', json: input }),
    onSuccess: () => router.push(next),
  });

  if (checking) {
    return (
      <div role="status" aria-live="polite">
        <Heading title="Oturumunuz yenileniyor" lead="Kaldığınız yere dönmeniz birkaç saniye sürer." />
      </div>
    );
  }

  const qs = next === '/app' ? '' : `?next=${encodeURIComponent(next)}`;

  return (
    <>
      <Heading title="Tekrar hoş geldiniz" lead="Arama profilleriniz ve yeni fırsatlar sizi bekliyor." />
      <form noValidate onSubmit={handleSubmit((v) => login.mutate(v))} className="space-y-4">
        <Field
          label="E-posta"
          type="email"
          autoComplete="email"
          error={errors.email?.message}
          {...register('email')}
        />
        <Field
          label="Şifre"
          type="password"
          autoComplete="current-password"
          error={errors.password?.message}
          {...register('password')}
        />
        <FormError>{login.isError ? apiErrorMessage(login.error) : reasonMessage}</FormError>
        <Button type="submit" size="lg" className="w-full" disabled={login.isPending}>
          {login.isPending ? 'Giriş yapılıyor…' : 'Giriş yap'}
        </Button>
      </form>
      <div className="mt-6 flex flex-col gap-2 text-sm text-[var(--color-muted)]">
        <Link href="/sifremi-unuttum" className={authLinkClass}>
          Şifremi unuttum
        </Link>
        <p>
          Hesabınız yok mu?{' '}
          <Link href={`/kayit${qs}`} className={authLinkClass}>
            Ücretsiz kaydolun
          </Link>
        </p>
      </div>
    </>
  );
}
