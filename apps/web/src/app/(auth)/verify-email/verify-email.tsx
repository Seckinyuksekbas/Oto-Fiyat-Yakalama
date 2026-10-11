'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { resendVerificationSchema } from '@oto/shared';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { apiErrorMessage, trErrorMap } from '@/lib/messages';
import { authLinkClass, Field, FormError, FormNotice, Heading } from '../_components/form-bits';

type Status = 'pending' | 'success' | 'error' | 'missing';
type ResendInput = z.infer<typeof resendVerificationSchema>;

function ResendForm() {
  const [sent, setSent] = useState(false);
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
    } catch {
      /* hesap varlığı sızdırılmaz */
    }
    setSent(true);
  };
  if (sent) {
    return <FormNotice>Bu adresle bekleyen bir doğrulama varsa yeni bağlantıyı gönderdik.</FormNotice>;
  }
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
  const token = useSearchParams().get('token') ?? '';
  const [status, setStatus] = useState<Status>(token ? 'pending' : 'missing');
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // Token tek kullanımlık; StrictMode çift efektinde ikinci POST başarısız olmasın.
    if (!token || started.current) return;
    started.current = true;
    apiFetch('/auth/verify-email', { method: 'POST', json: { token } })
      .then(() => setStatus('success'))
      .catch((e: unknown) => {
        setError(apiErrorMessage(e));
        setStatus('error');
      });
  }, [token]);

  return (
    <>
      <Heading title="E-posta doğrulama" />
      {status === 'pending' && (
        <p role="status" className="text-sm text-[var(--color-muted)]">
          Bağlantınız doğrulanıyor…
        </p>
      )}
      {status === 'success' && (
        <>
          <FormNotice>E-posta adresiniz doğrulandı. Artık tüm özellikleri kullanabilirsiniz.</FormNotice>
          <Button asChild size="lg" className="mt-5 w-full">
            <Link href="/app">Panele git</Link>
          </Button>
        </>
      )}
      {(status === 'error' || status === 'missing') && (
        <div className="space-y-5">
          <FormError>{status === 'missing' ? 'Doğrulama bağlantısı eksik. Yeni bir bağlantı isteyin.' : error}</FormError>
          <p className="text-sm text-[var(--color-muted)]">E-posta adresinizi yazın, yeni bağlantıyı gönderelim.</p>
          <ResendForm />
          <p className="text-sm">
            <Link href="/giris" className={authLinkClass}>
              Girişe dön
            </Link>
          </p>
        </div>
      )}
    </>
  );
}
