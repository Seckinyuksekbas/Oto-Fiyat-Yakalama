'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { resetPasswordSchema } from '@oto/shared';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { apiErrorMessage, trErrorMap } from '@/lib/messages';
import { authLinkClass, Field, FormError, FormNotice, Heading } from '../_components/form-bits';

const formSchema = resetPasswordSchema.pick({ newPassword: true });
type Input = z.infer<typeof formSchema>;

export function ResetPasswordForm() {
  const token = useSearchParams().get('token') ?? '';
  const tokenOk = resetPasswordSchema.shape.token.safeParse(token).success;
  const [done, setDone] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Input>({
    resolver: zodResolver(formSchema, { errorMap: trErrorMap }),
    defaultValues: { newPassword: '' },
  });

  const reset = useMutation({
    mutationFn: (v: Input) => apiFetch('/auth/reset-password', { method: 'POST', json: { token, ...v } }),
    onSuccess: () => setDone(true),
  });

  if (!tokenOk) {
    return (
      <>
        <Heading title="Şifre yenileme" />
        <FormError>Bağlantı geçersiz veya eksik. Yeni bir şifre yenileme bağlantısı isteyin.</FormError>
        <p className="mt-6 text-sm">
          <Link href="/sifremi-unuttum" className={authLinkClass}>
            Yeni bağlantı iste
          </Link>
        </p>
      </>
    );
  }

  return (
    <>
      <Heading title="Yeni şifre belirleyin" lead="Güvenliğiniz için tüm açık oturumlar kapatılabilir." />
      <FormNotice>{done ? 'Şifreniz güncellendi. Yeni şifrenizle giriş yapabilirsiniz.' : null}</FormNotice>
      {done ? (
        <Button asChild size="lg" className="mt-5 w-full">
          <Link href="/giris">Giriş yap</Link>
        </Button>
      ) : (
        <form noValidate onSubmit={handleSubmit((v) => reset.mutate(v))} className="space-y-4">
          <Field
            label="Yeni şifre"
            type="password"
            autoComplete="new-password"
            hint="En az 10 karakter."
            error={errors.newPassword?.message}
            {...register('newPassword')}
          />
          <FormError>{reset.isError ? apiErrorMessage(reset.error) : null}</FormError>
          <Button type="submit" size="lg" className="w-full" disabled={reset.isPending}>
            {reset.isPending ? 'Güncelleniyor…' : 'Şifreyi güncelle'}
          </Button>
        </form>
      )}
    </>
  );
}
