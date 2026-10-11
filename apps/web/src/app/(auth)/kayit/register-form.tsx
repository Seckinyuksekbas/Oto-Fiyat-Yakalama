'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { registerSchema, type RegisterInput } from '@oto/shared';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { apiErrorMessage, trErrorMap } from '@/lib/messages';
import { safeNextPath } from '@/lib/session';
import { authLinkClass, Field, FormError, Heading } from '../_components/form-bits';

export function RegisterForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNextPath(params.get('next'));

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema, { errorMap: trErrorMap }),
    // kvkkAccepted şema türü `true`; onay verilene kadar false başlar
    defaultValues: { name: '', email: '', password: '', kvkkAccepted: false as unknown as true },
  });

  const signUp = useMutation({
    mutationFn: (input: RegisterInput) => apiFetch('/auth/register', { method: 'POST', json: input }),
    onSuccess: () => router.push(next),
  });

  const qs = next === '/app' ? '' : `?next=${encodeURIComponent(next)}`;

  return (
    <>
      <Heading
        title="Hesap oluşturun"
        lead="Piyasanın altındaki ilanlar için arama profili kurun; eşleşmeler size ulaşsın."
      />
      <form noValidate onSubmit={handleSubmit((v) => signUp.mutate(v))} className="space-y-4">
        <Field label="Ad" autoComplete="name" error={errors.name?.message} {...register('name')} />
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
          autoComplete="new-password"
          hint="En az 10 karakter."
          error={errors.password?.message}
          {...register('password')}
        />

        <div className="space-y-1.5">
          <label className="flex cursor-pointer items-start gap-3 text-sm leading-snug">
            <input
              type="checkbox"
              aria-invalid={errors.kvkkAccepted ? true : undefined}
              aria-describedby={errors.kvkkAccepted ? 'kvkk-error' : undefined}
              className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--color-accent)]"
              {...register('kvkkAccepted')}
            />
            <span>
              <Link href="/kvkk" target="_blank" className={authLinkClass}>
                KVKK aydınlatma metnini
              </Link>{' '}
              okudum, kişisel verilerimin işlenmesini kabul ediyorum.
            </span>
          </label>
          {errors.kvkkAccepted ? (
            <p id="kvkk-error" className="text-[13px] text-[var(--color-danger)]">
              {errors.kvkkAccepted.message}
            </p>
          ) : null}
        </div>

        <FormError>{signUp.isError ? apiErrorMessage(signUp.error) : null}</FormError>
        <Button type="submit" size="lg" className="w-full" disabled={signUp.isPending}>
          {signUp.isPending ? 'Hesap oluşturuluyor…' : 'Hesap oluştur'}
        </Button>
      </form>
      <p className="mt-6 text-sm text-[var(--color-muted)]">
        Zaten hesabınız var mı?{' '}
        <Link href={`/giris${qs}`} className={authLinkClass}>
          Giriş yapın
        </Link>
      </p>
    </>
  );
}
