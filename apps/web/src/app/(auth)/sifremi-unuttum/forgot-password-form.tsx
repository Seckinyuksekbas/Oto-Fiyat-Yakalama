'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { forgotPasswordSchema } from '@oto/shared';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { trErrorMap } from '@/lib/messages';
import { authLinkClass, Field, FormNotice, Heading } from '../_components/form-bits';

type Input = z.infer<typeof forgotPasswordSchema>;

export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Input>({
    resolver: zodResolver(forgotPasswordSchema, { errorMap: trErrorMap }),
    defaultValues: { email: '' },
  });

  // Hesap var mı yok mu sızdırılmaz: sonuç ne olursa olsun aynı mesaj gösterilir.
  const onSubmit = async (values: Input) => {
    try {
      await apiFetch('/auth/forgot-password', { method: 'POST', json: values });
    } catch {
      /* bilinçli olarak yutulur */
    }
    setSent(true);
  };

  return (
    <>
      <Heading title="Şifrenizi mi unuttunuz?" lead="E-posta adresinizi yazın, şifre yenileme bağlantısı gönderelim." />
      {sent ? (
        <FormNotice>
          Bu adresle kayıtlı bir hesap varsa şifre yenileme bağlantısı gönderdik. Gelen kutunuzu ve istenmeyen
          klasörünü kontrol edin.
        </FormNotice>
      ) : (
        <form noValidate onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Field
            label="E-posta"
            type="email"
            autoComplete="email"
            error={errors.email?.message}
            {...register('email')}
          />
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
