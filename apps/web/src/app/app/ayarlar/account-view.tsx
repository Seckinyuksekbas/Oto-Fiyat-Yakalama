'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { BadgeCheck, MailWarning } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { NETWORK_MESSAGE, RATE_LIMIT_MESSAGE, apiErrorMessage } from '@/lib/messages';
import { useMe } from '@/lib/queries';
import { useDeleteAccount, useUpdateName } from '@/lib/settings-queries';

function deleteErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429 || err.code === 'RATE_LIMITED') return RATE_LIMIT_MESSAGE;
    if (err.code === 'INVALID_CREDENTIALS') return 'Şifre hatalı';
    if (err.code === 'INVALID_OPERATION') return 'Bu hesap silinemez: sistemdeki son yönetici hesabısınız.';
    return apiErrorMessage(err);
  }
  return NETWORK_MESSAGE;
}

function DeleteAccount() {
  const router = useRouter();
  const del = useDeleteAccount();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [local, setLocal] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!password) {
      setLocal('Onaylamak için şifrenizi girin');
      return;
    }
    setLocal(null);
    del.mutate(password, { onSuccess: () => router.replace('/') });
  };
  const error = local ?? (del.error ? deleteErrorMessage(del.error) : null);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setPassword('');
          setLocal(null);
          del.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="danger">Hesabı sil</Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Hesabınızı silmek üzeresiniz</DialogTitle>
            <DialogDescription>
              Bu işlem geri alınamaz. KVKK kapsamında kişisel verileriniz (ad, e-posta, oturumlar, bağlı kanallar)
              silinir veya anonimleştirilir; arama profilleriniz, favorileriniz ve bildirimleriniz kaldırılır.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="del-pw">Şifreniz</Label>
            <Input
              id="del-pw"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'del-err' : undefined}
            />
            {error ? (
              <p id="del-err" role="alert" className="text-sm text-danger-text">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Vazgeç
            </Button>
            <Button type="submit" variant="danger" disabled={del.isPending}>
              Hesabımı kalıcı olarak sil
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AccountView() {
  const me = useMe();
  const update = useUpdateName();
  const [draft, setDraft] = useState<string | null>(null);

  if (me.isPending) return <Skeleton className="h-64 w-full" aria-busy="true" />;
  if (me.isError) {
    return (
      <Card className="p-6 text-sm" role="alert">
        Hesap bilgileri yüklenemedi.
      </Card>
    );
  }

  const user = me.data.user;
  const name = draft ?? user.name;
  const trimmed = name.trim();
  const dirty = trimmed !== user.name && trimmed.length > 0;
  const verified = Boolean(user.emailVerifiedAt);

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    update.mutate(trimmed, {
      onSuccess: () => {
        setDraft(null);
        toast.success('Adınız güncellendi');
      },
    });
  };

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <form onSubmit={save} className="grid gap-5" noValidate>
          <div>
            <h2 className="font-display text-lg font-semibold">Profil</h2>
            <p className="text-sm text-muted">Bildirimlerde ve hesabınızda bu ad görünür.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="acc-name">Ad soyad</Label>
            <Input
              id="acc-name"
              value={name}
              maxLength={80}
              autoComplete="name"
              onChange={(e) => setDraft(e.target.value)}
            />
            {update.isError ? (
              <p role="alert" className="text-sm text-danger-text">
                {apiErrorMessage(update.error)}
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">E-posta</p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm">{user.email}</span>
              {verified ? (
                <Badge tone="positive">
                  <BadgeCheck aria-hidden className="size-3.5" />
                  Doğrulandı
                </Badge>
              ) : (
                <Badge tone="warning">
                  <MailWarning aria-hidden className="size-3.5" />
                  Doğrulanmadı
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted">E-posta adresi değiştirilemez.</p>
          </div>
          <div>
            <Button type="submit" disabled={!dirty || update.isPending}>
              Kaydet
            </Button>
          </div>
        </form>
      </Card>

      <Card className="border-danger/40 p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="max-w-[52ch]">
            <h2 className="font-display text-lg font-semibold">Hesabı sil</h2>
            <p className="text-sm text-muted">
              Hesabınız ve ona bağlı tüm veriler kalıcı olarak kaldırılır. Bu işlem geri alınamaz.
            </p>
          </div>
          <DeleteAccount />
        </div>
      </Card>
    </div>
  );
}
