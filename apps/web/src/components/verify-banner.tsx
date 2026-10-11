'use client';
import { useEffect, useState } from 'react';
import { MailWarning } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { useMe, useResendVerification } from '@/lib/queries';

export function VerifyBanner() {
  const me = useMe();
  const resend = useResendVerification();
  const user = me.data?.user;
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

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
          {resend.isSuccess && wait > 0
            ? `Bağlantı gönderildi: ${user.email}. Yeniden göndermek için ${wait} sn bekleyin.`
            : resend.isSuccess
              ? `Bağlantı gönderildi: ${user.email}`
              : failure}
        </span>
        <Button variant="secondary" size="sm" disabled={resend.isPending || wait > 0}
          onClick={() => resend.mutate(user.email, { onSuccess: () => setWait(60) })}
        >
          Bağlantıyı yeniden gönder
        </Button>
      </div>
    </div>
  );
}
