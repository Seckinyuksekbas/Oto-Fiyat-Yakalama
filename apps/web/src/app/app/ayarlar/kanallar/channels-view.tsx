'use client';
import { useEffect, useState } from 'react';
import { BellRing, ExternalLink, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { ApiError } from '@/lib/api';
import { NETWORK_MESSAGE, RATE_LIMIT_MESSAGE, apiErrorMessage } from '@/lib/messages';
import { useMe } from '@/lib/queries';
import {
  useChannels,
  useLinkTelegram,
  usePatchChannel,
  useUnlinkTelegram,
  type TelegramLink,
} from '@/lib/settings-queries';

const POLL_MS = 5000;
const VERIFY_MSG = 'Telegram bağlamak için e-posta adresinizi doğrulayın.';
const UNAVAILABLE_MSG = 'Telegram bildirimleri şu anda kullanılamıyor';
const NO_PLAN_MSG = 'Mevcut planınız Telegram bildirimlerini içermiyor. Bağlamak için planınızı yükseltin.';

function linkErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return NETWORK_MESSAGE;
  if (err.code === 'EMAIL_NOT_VERIFIED') return VERIFY_MSG;
  if (err.code === 'LIMIT_REACHED') return NO_PLAN_MSG;
  if (err.code === 'FEATURE_DISABLED') return `${UNAVAILABLE_MSG}. Daha sonra tekrar deneyin.`;
  if (err.status === 429 || err.code === 'RATE_LIMITED') return RATE_LIMIT_MESSAGE;
  return apiErrorMessage(err);
}

function formatCountdown(sec: number): string {
  const s = Math.max(0, sec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="rounded-md border border-border bg-surface-2 px-3 py-2.5 text-sm text-muted">
      {children}
    </p>
  );
}

function UnlinkDialog({ onConfirm, pending }: { onConfirm: () => void; pending: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          Bağlantıyı kaldır
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Telegram bağlantısı kaldırılsın mı?</DialogTitle>
          <DialogDescription>
            Fırsat bildirimleri Telegram&apos;a gönderilmez; uygulama içi bildirimler sürer. İstediğiniz zaman yeniden
            bağlayabilirsiniz.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Vazgeç
          </Button>
          <Button
            variant="danger"
            disabled={pending}
            onClick={() => {
              onConfirm();
              setOpen(false);
            }}
          >
            Evet, kaldır
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TelegramCard() {
  const me = useMe();
  const link = useLinkTelegram();
  const patch = usePatchChannel();
  const unlink = useUnlinkTelegram();
  const [pending, setPending] = useState<TelegramLink | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const remaining = pending ? Math.ceil((new Date(pending.expiresAt).getTime() - now) / 1000) : 0;
  const waiting = pending !== null && remaining > 0;
  const expired = pending !== null && remaining <= 0;

  const channels = useChannels(waiting ? POLL_MS : undefined);
  const tg = channels.data?.items.find((c) => c.type === 'TELEGRAM');
  const isLinked = Boolean(tg?.isVerified);

  // Geri sayım: yalnızca bağlantı beklenirken çalışır; kapanışta temizlenir.
  useEffect(() => {
    if (!waiting) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);

  useEffect(() => {
    if (pending && isLinked) {
      setPending(null);
      toast.success('Telegram bağlandı');
    }
  }, [pending, isLinked]);

  if (channels.isPending || me.isPending) return <Skeleton className="h-40 w-full" aria-busy="true" />;
  if (channels.isError) {
    return (
      <Card className="p-6 text-sm" role="alert">
        Kanallar yüklenemedi.
      </Card>
    );
  }

  const available = channels.data?.telegramAvailable ?? false;
  const verified = Boolean(me.data?.user.emailVerifiedAt);

  const start = () => {
    link.mutate(undefined, {
      onSuccess: (res) => {
        setNow(Date.now());
        setPending(res);
      },
    });
  };

  let body: React.ReactNode;
  if (!available) {
    body = <Notice>{UNAVAILABLE_MSG}</Notice>;
  } else if (isLinked) {
    body = (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-3 text-sm">
          <Switch
            aria-label="Telegram bildirimleri"
            checked={tg?.isEnabled ?? false}
            disabled={patch.isPending}
            onCheckedChange={(v) => patch.mutate({ type: 'TELEGRAM', isEnabled: v })}
          />
          <span>{tg?.isEnabled ? 'Bildirimler açık' : 'Bildirimler kapalı'}</span>
        </label>
        <UnlinkDialog pending={unlink.isPending} onConfirm={() => unlink.mutate()} />
      </div>
    );
  } else if (!verified) {
    body = <Notice>{VERIFY_MSG}</Notice>;
  } else if (waiting && pending) {
    body = (
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Telegram&apos;ı açın ve botta <strong className="text-text">Başlat</strong>&apos;a dokunun. Hesabınız
          otomatik olarak bağlanır.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Button asChild>
            <a href={pending.deepLink} target="_blank" rel="noopener noreferrer">
              Telegram&apos;ı aç
              <ExternalLink aria-hidden />
            </a>
          </Button>
          <p role="status" className="flex items-center gap-3 text-sm text-muted">
            <span className="size-2 animate-pulse rounded-full bg-accent motion-reduce:animate-none" aria-hidden />
            Bağlantı bekleniyor…
            <span className="font-mono tabular-nums text-text" aria-label="Kalan süre">
              {formatCountdown(remaining)}
            </span>
          </p>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="space-y-3">
        {expired ? (
          <Notice>Bağlantının süresi doldu. Yeni bir bağlantı oluşturun.</Notice>
        ) : (
          <p className="text-sm text-muted">
            Yeni fırsatlar anında Telegram&apos;a düşsün. Bağlantı oluşturulunca 10 dakika içinde botta Başlat&apos;a
            dokunmanız yeterli.
          </p>
        )}
        <Button onClick={start} disabled={link.isPending}>
          {expired ? 'Yeni bağlantı oluştur' : "Telegram'ı bağla"}
        </Button>
      </div>
    );
  }

  const linkError = !isLinked && !waiting && link.isError ? linkErrorMessage(link.error) : null;
  const patchError = patch.isError ? apiErrorMessage(patch.error) : null;

  return (
    <Card className="space-y-4 p-6">
      <div className="flex items-start gap-3">
        <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-md bg-surface-2 text-muted">
          <Send className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-lg font-semibold">Telegram</h2>
          <p className="text-sm text-muted">Anlık fırsat bildirimleri cebinize gelir.</p>
        </div>
        {isLinked ? <Badge tone="positive">Bağlandı</Badge> : <Badge>Bağlı değil</Badge>}
      </div>
      {body}
      {linkError ? (
        <p role="alert" className="text-sm text-danger-text">
          {linkError}
        </p>
      ) : null}
      {patchError ? (
        <p role="alert" className="text-sm text-danger-text">
          {patchError}
        </p>
      ) : null}
    </Card>
  );
}

export function ChannelsView() {
  return (
    <div className="space-y-6">
      <Card className="p-6">
        <div className="flex items-start gap-3">
          <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-md bg-surface-2 text-muted">
            <BellRing className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-lg font-semibold">Uygulama içi</h2>
            <p className="text-sm text-muted">Zil simgesi ve Bildirimler sayfası. Her zaman açıktır.</p>
          </div>
          <Badge tone="positive">Her zaman açık</Badge>
        </div>
      </Card>
      <TelegramCard />
    </div>
  );
}
