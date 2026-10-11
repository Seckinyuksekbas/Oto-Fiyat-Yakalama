'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { forgotPasswordSchema } from '@oto/shared';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { leakSafeFailure, trErrorMap } from '@/lib/messages';
import { authLinkClass, Field, FormError, FormNotice, Heading } from '../_components/form-bits';

type Input = z.infer<typeof forgotPasswordSchema>;

export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Input>({
    resolver: zodResolver(forgotPasswordSchema, { errorMap: trErrorMap }),
    defaultValues: { email: '' },
  });

  // Hesap var mı yok mu sızdırılmaz: yalnızca hız sınırı ve ağ hatası ayrı gösterilir.
  const onSubmit = async (values: Input) => {
    setFailure(null);
    try {
      await apiFetch('/auth/forgot-password', { method: 'POST', json: values });
    } catch (e) {
      const msg = leakSafeFailure(e);
      if (msg) {
        setFailure(msg);
        return;
      }
    }
    setSent(true);
  };

  return (
    <>
      <Heading title="Şifrenizi mi unuttunuz?" lead="E-posta adresinizi yazın, şifre yenileme bağlantısı gönderelim." />
      <FormNotice>
        {sent
          ? 'Bu adresle kayıtlı bir hesap varsa şifre yenileme bağlantısı gönderdik. Gelen kutunuzu ve istenmeyen klasörünü kontrol edin.'
          : null}
      </FormNotice>
      {sent ? null : (
        <form noValidate onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Field
            label="E-posta"
            type="email"
            autoComplete="email"
            error={errors.email?.message}
            {...register('email')}
          />
          <FormError>{failure}</FormError>
          <Button type="submit" size="lg" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Gönderiliyor…' : 'Bağlantı gönder'}
          </Button>
        </form>
      )}
      <p className="mt-6 text-sm text-[var(--color-muted)]">
        <Link href="/giris" className={authLinkClass}>
          Girişe dön
        </Link>
      </p>
    </>
  );
}
