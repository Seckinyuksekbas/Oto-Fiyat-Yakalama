'use client';
import { useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity, Loader2, Network, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { When } from '@/components/admin/catalog/cells';
import { DataTable, type DataColumn } from '@/components/admin/data-table';
import { formatDurationMs } from '@/components/admin/kpi-tile';
import { StatusBadge } from '@/components/admin/status-badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { adminErrorMessage, adminFieldErrors, type Paged } from '@/lib/admin-api';
import { catalogApi, proxyCheckErrorMessage, type AdminProxy, type ProxyWrite } from '@/lib/admin/catalog-api';
import { catalogKeys, useAdminProxies } from '@/lib/admin/catalog-queries';

/**
 * Proxy URL'si kimlik bilgisi taşır. Kurallar:
 * - Sunucu URL'yi her zaman `http://***@host:port` maskeli döndürür; ekranda yalnızca bu görünür.
 * - Adres alanı kontrolsüzdür (React durumunda tutulmaz); gönderim anında okunur ve sonuç ne olursa olsun hemen boşaltılır.
 * - Oluşturma/düzenleme `useMutation` ile yapılmaz: mutasyon önbelleği değişkenleri (URL'yi) saklardı.
 */

function useInvalidateProxies() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: catalogKeys.proxies.all });
}

/** Adres alanını okuyup anında temizler. */
function takeSecret(ref: React.RefObject<HTMLInputElement | null>): string {
  const el = ref.current;
  if (!el) return '';
  const v = el.value.trim();
  el.value = '';
  return v;
}

function fieldMessages(err: unknown) {
  const fe = adminFieldErrors(err);
  return { name: fe.name, url: fe.url, form: Object.keys(fe).length > 0 ? null : adminErrorMessage(err) };
}

// ---------------------------------------------------------------- oluşturma

function CreateProxyForm() {
  const uid = useId();
  const urlRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; url?: string; form?: string | null }>({});
  const invalidate = useInvalidateProxies();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const url = takeSecret(urlRef);
    const next: typeof errors = {};
    if (!name.trim()) next.name = 'Bir ad girin.';
    if (!url) next.url = 'Proxy adresini girin.';
    else if (!/^https?:\/\//i.test(url)) next.url = 'Yalnızca http:// ya da https:// adresleri.';
    if (next.name || next.url) {
      setErrors(next);
      return;
    }
    setErrors({});
    setPending(true);
    try {
      await catalogApi.proxies.create({ name: name.trim(), url, isEnabled: enabled });
      setName('');
      setEnabled(true);
      toast.success('Proxy eklendi');
      await invalidate();
    } catch (err) {
      setErrors(fieldMessages(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <form aria-label="Yeni proxy" noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-base font-semibold">Proxy ekle</h2>
        <p className="text-[13px] text-muted">Adres kayıttan sonra şifreli saklanır ve bir daha gösterilmez; değiştirmek için yenisini yazarsınız.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] md:items-start">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${uid}-name`} className="text-sm font-medium">
            Ad
          </label>
          <Input
            id={`${uid}-name`}
            value={name}
            maxLength={100}
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? `${uid}-name-error` : undefined}
            onChange={(e) => setName(e.target.value)}
          />
          {errors.name ? (
            <p id={`${uid}-name-error`} className="text-[13px] text-danger-text">
              {errors.name}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${uid}-url`} className="text-sm font-medium">
            Proxy adresi
          </label>
          <Input
            ref={urlRef}
            id={`${uid}-url`}
            name="proxy-url"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            maxLength={500}
            placeholder="http://kullanici:parola@host:port"
            aria-invalid={!!errors.url}
            aria-describedby={errors.url ? `${uid}-url-error` : undefined}
            className="num"
          />
          {errors.url ? (
            <p id={`${uid}-url-error`} className="text-[13px] text-danger-text">
              {errors.url}
            </p>
          ) : null}
        </div>
        <label className="inline-flex items-center gap-2 text-sm md:pt-8">
          <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Etkin
        </label>
      </div>
      {errors.form ? (
        <p role="alert" className="text-sm text-danger-text">
          {errors.form}
        </p>
      ) : null}
      <Button type="submit" className="w-fit" disabled={pending}>
        {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
        Proxy ekle
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------- düzenleme

function EditProxyDialog({ proxy, onClose }: { proxy: AdminProxy; onClose(): void }) {
  const uid = useId();
  const urlRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(proxy.name);
  const [enabled, setEnabled] = useState(proxy.isEnabled);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; url?: string; form?: string | null }>({});
  const invalidate = useInvalidateProxies();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const url = takeSecret(urlRef);
    const body: ProxyWrite = {};
    if (name.trim() !== proxy.name) body.name = name.trim();
    if (enabled !== proxy.isEnabled) body.isEnabled = enabled;
    if (url) {
      if (!/^https?:\/\//i.test(url)) {
        setErrors({ url: 'Yalnızca http:// ya da https:// adresleri.' });
        return;
      }
      body.url = url;
    }
    if (!name.trim()) {
      setErrors({ name: 'Bir ad girin.' });
      return;
    }
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setErrors({});
    setPending(true);
    try {
      await catalogApi.proxies.update(proxy.id, body);
      toast.success('Proxy kaydedildi');
      await invalidate();
      onClose();
    } catch (err) {
      setErrors(fieldMessages(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent>
        <form noValidate onSubmit={(e) => void submit(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Proxy düzenle</DialogTitle>
            <DialogDescription>
              Geçerli adres: <span className="num">{proxy.url}</span>. Adresi değiştirirseniz son kontrol sonucu sıfırlanır.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${uid}-name`} className="text-sm font-medium">
              Ad
            </label>
            <Input id={`${uid}-name`} value={name} maxLength={100} aria-invalid={!!errors.name} onChange={(e) => setName(e.target.value)} />
            {errors.name ? <p className="text-[13px] text-danger-text">{errors.name}</p> : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${uid}-url`} className="text-sm font-medium">
              Yeni proxy adresi (boş bırakırsanız değişmez)
            </label>
            <Input
              ref={urlRef}
              id={`${uid}-url`}
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              maxLength={500}
              className="num"
              aria-invalid={!!errors.url}
            />
            {errors.url ? <p className="text-[13px] text-danger-text">{errors.url}</p> : null}
          </div>
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Etkin
          </label>
          {errors.form ? (
            <p role="alert" className="text-sm text-danger-text">
              {errors.form}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
              Vazgeç
            </Button>
            <Button type="submit" disabled={pending}>
              Kaydet
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- liste

function CheckButton({ proxy }: { proxy: AdminProxy }) {
  const qc = useQueryClient();
  const check = useMutation({
    mutationFn: () => catalogApi.proxies.check(proxy.id),
    onSuccess: ({ proxy: updated }) => {
      qc.setQueryData<Paged<AdminProxy>>(catalogKeys.proxies.list(), (prev) =>
        prev ? { ...prev, items: prev.items.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)) } : prev,
      );
      if (updated.lastError) toast.error(`Kontrol başarısız: ${updated.lastError}`);
      else if (updated.lastLatencyMs !== null) toast.success(`Proxy yanıt verdi: ${formatDurationMs(updated.lastLatencyMs)}`);
    },
    onError: (err) => toast.error(proxyCheckErrorMessage(err)),
  });
  return (
    <Button variant="secondary" size="sm" aria-label={`${proxy.name} kontrol et`} disabled={check.isPending} onClick={() => check.mutate()}>
      {check.isPending ? <Loader2 aria-hidden className="animate-spin" /> : <Activity aria-hidden />}
      Kontrol et
    </Button>
  );
}

function LastCheck({ p }: { p: AdminProxy }) {
  if (!p.lastCheckAt) return <span className="text-muted">Hiç kontrol edilmedi</span>;
  return (
    <span className="flex flex-col">
      {p.lastError ? (
        <span className="break-words text-danger-text">{p.lastError}</span>
      ) : p.lastLatencyMs !== null ? (
        <span className="num text-positive-text">{formatDurationMs(p.lastLatencyMs)}</span>
      ) : (
        <span className="text-muted">Sonuç yok</span>
      )}
      <span className="text-[12px] text-muted">
        <When iso={p.lastCheckAt} />
      </span>
    </span>
  );
}

export function AdminProxiesView() {
  const q = useAdminProxies();
  const [editing, setEditing] = useState<AdminProxy | null>(null);

  const columns: DataColumn<AdminProxy>[] = [
    {
      id: 'name',
      header: 'Proxy',
      primary: true,
      cell: (p) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{p.name}</span>
          <span className="num truncate text-[12px] text-muted">{p.url}</span>
        </span>
      ),
    },
    {
      id: 'enabled',
      header: 'Durum',
      cell: (p) => (p.isEnabled ? <StatusBadge status="ENABLED" label="Etkin" tone="positive" /> : <StatusBadge status="DISABLED" label="Kapalı" tone="neutral" />),
    },
    { id: 'check', header: 'Son kontrol', cell: (p) => <LastCheck p={p} /> },
    { id: 'sources', header: 'Kullanan kaynak', numeric: true, cell: (p) => p.sourceCount ?? 0 },
    {
      id: 'actions',
      header: 'İşlemler',
      srOnlyHeader: true,
      cell: (p) => (
        <span className="flex flex-wrap justify-end gap-2">
          <CheckButton proxy={p} />
          <Button variant="ghost" size="sm" aria-label={`${p.name} düzenle`} onClick={() => setEditing(p)}>
            <Pencil aria-hidden />
            Düzenle
          </Button>
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="sr-only">Proxy&apos;ler</h1>
      <p className="max-w-[72ch] text-sm text-muted">
        Proxy&apos;ler yalnızca ağ çıkışını sabitlemek içindir. Engel aşmak için proxy döndürme yapılmaz; engellenen kaynak duraklar.
      </p>
      <DataTable
        caption="Proxy'ler"
        columns={columns}
        rowKey={(p) => p.id}
        data={q.data}
        isPending={q.isPending}
        isError={q.isError}
        onRetry={() => void q.refetch()}
        page={1}
        pageSize={100}
        onPageChange={() => undefined}
        empty={{ icon: <Network className="size-5" />, title: 'Tanımlı proxy yok', description: 'Kaynaklar doğrudan bağlanır. Gerekirse aşağıdan bir çıkış proxy’si ekleyin.' }}
      />
      <CreateProxyForm />
      {editing ? <EditProxyDialog key={editing.id} proxy={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}
