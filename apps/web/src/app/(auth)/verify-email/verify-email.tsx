'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { resendVerificationSchema, verifyEmailSchema } from '@oto/shared';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { ApiError, apiFetch } from '@/lib/api';
import { apiErrorMessage, leakSafeFailure, trErrorMap } from '@/lib/messages';
import { authLinkClass, Field, FormError, FormNotice, Heading } from '../_components/form-bits';

type Status = 'pending' | 'success' | 'error' | 'network' | 'invalid';
type ResendInput = z.infer<typeof resendVerificationSchema>;

function ResendForm({ onSent, onFailure }: { onSent: () => void; onFailure: (message: string) => void }) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResendInput>({
    resolver: zodResolver(resendVerificationSchema, { errorMap: trErrorMap }),
    defaultValues: { email: '' },
  });
  const onSubmit = async (v: ResendInput) => {
    try {
      await apiFetch('/auth/resend-verification', { method: 'POST', json: v });
    } catch (e) {
      const msg = leakSafeFailure(e);
      if (msg) {
        onFailure(msg);
        return;
      }
    }
    onSent();
  };
  return (
    <form noValidate onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <Field label="E-posta" type="email" autoComplete="email" error={errors.email?.message} {...register('email')} />
      <Button type="submit" variant="secondary" className="w-full" disabled={isSubmitting}>
        Yeniden gönder
      </Button>
    </form>
  );
}

export function VerifyEmail() {
  // Token ilk okunduğunda saklanır; adres çubuğundan silinse bile "Tekrar dene" çalışır.
  const params = useSearchParams();
  const tokenRef = useRef<string | null>(null);
  tokenRef.current ??= params.get('token') ?? '';
  const tokenValid = verifyEmailSchema.safeParse({ token: tokenRef.current }).success;

  const [status, setStatus] = useState<Status>(tokenValid ? 'pending' : 'invalid');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const started = useRef(false);

  const run = useCallback(() => {
    setStatus('pending');
    setError(null);
    apiFetch('/auth/verify-email', { method: 'POST', json: { token: tokenRef.current } })
      .then(() => setStatus('success'))
      .catch((e: unknown) => {
        setError(apiErrorMessage(e));
        setStatus(e instanceof ApiError ? 'error' : 'network');
      });
  }, []);

  useEffect(() => {
    // Token tek kullanımlık; StrictMode çift efektinde ikinci POST başarısız olmasın.
    if (started.current) return;
    started.current = true;
    if (window.location.search.includes('token=')) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
    if (tokenValid) run();
  }, [tokenValid, run]);

  const message =
    status === 'pending'
      ? 'Bağlantınız doğrulanıyor…'
      : status === 'success'
        ? 'E-posta adresiniz doğrulandı. Artık tüm özellikleri kullanabilirsiniz.'
        : notice;

  return (
    <>
      <Heading title="E-posta doğrulama" />
      <FormNotice>{message}</FormNotice>
      <FormError>
        {status === 'invalid' ? 'Doğrulama bağlantısı geçersiz veya eksik. Yeni bir bağlantı isteyin.' : error}
      </FormError>

      {status === 'success' && (
        <Button asChild size="lg" className="mt-5 w-full">
          <Link href="/app">Panele git</Link>
        </Button>
      )}
      {status === 'network' && (
        <Button variant="secondary" className="mt-4 w-full" onClick={run}>
          Tekrar dene
        </Button>
      )}
      {(status === 'error' || status === 'invalid') && (
        <div className="mt-5 space-y-5">
          <p className="text-sm text-[var(--color-muted)]">E-posta adresinizi yazın, yeni bağlantıyı gönderelim.</p>
          <ResendForm
            onSent={() => {
              setError(null);
              setNotice('Bu adresle bekleyen bir doğrulama varsa yeni bağlantıyı gönderdik.');
            }}
            onFailure={(m) => {
              setNotice(null);
              setError(m);
            }}
          />
        </div>
      )}
      {status !== 'success' && status !== 'pending' && (
        <p className="mt-5 text-sm">
          <Link href="/giris" className={authLinkClass}>
            Girişe dön
          </Link>
        </p>
      )}
    </>
  );
}
