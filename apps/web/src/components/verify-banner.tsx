'use client';
import { MailWarning } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { useMe, useResendVerification } from '@/lib/queries';

export function VerifyBanner() {
  const me = useMe();
  const resend = useResendVerification();
  const user = me.data?.user;
  if (!user || user.emailVerifiedAt) return null;

  const failure = resend.error
    ? resend.error instanceof ApiError && resend.error.status === 429
      ? 'Çok sık denediniz. Biraz bekleyip tekrar deneyin.'
      : 'Bağlantı gönderilemedi. Tekrar deneyin.'
    : null;

  return (
    <div
      role="region"
      aria-label="E-posta doğrulama"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-warning/40 bg-warning/10 px-4 py-2.5 text-sm md:px-8"
    >
      <MailWarning aria-hidden className="size-4 shrink-0 text-warning-text" />
      <p className="min-w-0 flex-1 basis-80">
        <strong className="font-semibold">E-postanızı doğrulayın</strong> — doğrulanmamış hesaplar 1 profil
        oluşturabilir ve Telegram bağlayamaz.
      </p>
      <div className="flex items-center gap-3">
        <span role="status" aria-live="polite" className="text-[13px] text-muted">
          {resend.isSuccess ? `Bağlantı gönderildi: ${user.email}` : failure}
        </span>
        <Button variant="secondary" size="sm" disabled={resend.isPending} onClick={() => resend.mutate(user.email)}>
          Bağlantıyı yeniden gönder
        </Button>
      </div>
    </div>
  );
}
