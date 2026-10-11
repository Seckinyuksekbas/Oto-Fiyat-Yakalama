import { formatCount, formatDurationMs } from '@/components/admin/kpi-tile';
import type { DryRunResult } from '@/lib/admin/catalog-api';
import { formatKm, formatTl } from '@/lib/format';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Dry-run sonucu: ilk 20 normalize ilan ve sorunlar. Hiçbir şey veritabanına yazılmadı; tablo yalnızca adapter'ın
 * ne gördüğünü gösterir. URL'ler API'de maskelidir ve bağlantıya dönüştürülmez.
 */
export function DryRunPreview({ result }: { result: DryRunResult }) {
  const { items, problems } = result;
  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-muted">
        <div className="flex gap-1.5">
          <dt>Sayfa</dt>
          <dd className="num text-text">{formatCount(result.pages)}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt>Süre</dt>
          <dd className="num text-text">{formatDurationMs(result.durationMs)}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt>Örnek ilan</dt>
          <dd className="num text-text">{formatCount(items.length)}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt>Sorun</dt>
          <dd className={problems.length > 0 ? 'num text-warning-text' : 'num text-text'}>{formatCount(problems.length)}</dd>
        </div>
      </dl>

      {items.length === 0 ? (
        <p className="text-sm text-muted">Adapter hiç ilan döndürmedi. Kaynak sayfasının yapısı ya da yapılandırma adresi değişmiş olabilir.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <caption className="sr-only">Dry-run önizlemesi: normalize edilen ilk {items.length} ilan</caption>
            <thead className="bg-surface-2 text-left text-[13px] text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">İlan</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Yıl</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Km</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Fiyat</th>
                <th scope="col" className="px-3 py-2 font-medium">Şehir</th>
                <th scope="col" className="px-3 py-2 font-medium">Adres</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => {
                const year = num(it.year);
                const km = num(it.km);
                const price = str(it.price);
                return (
                  <tr key={str(it.externalId) ?? i} className="border-t border-border align-top">
                    <td className="max-w-[300px] px-3 py-2">
                      <span className="block truncate">{str(it.title) ?? 'Başlıksız'}</span>
                      <span className="num block text-[12px] text-muted">{str(it.externalId) ?? 'kimlik yok'}</span>
                    </td>
                    <td className="num px-3 py-2 text-right">{year ?? '—'}</td>
                    <td className="num px-3 py-2 text-right">{km !== null ? formatKm(km) : '—'}</td>
                    <td className="num px-3 py-2 text-right">{price ? formatTl(price) : '—'}</td>
                    <td className="px-3 py-2">{str(it.city) ?? <span className="text-muted">yok</span>}</td>
                    <td className="max-w-[220px] px-3 py-2">
                      <span className="block truncate text-[12px] text-muted" title={str(it.url) ?? undefined}>
                        {str(it.url) ?? 'yok'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {problems.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-medium">Sorunlar</h4>
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {problems.map((p, i) => (
              <li key={i} className="flex flex-col gap-0.5 px-3 py-2 text-sm">
                <span>
                  <code className="num text-[13px] text-muted">{p.field}</code> {p.problem}
                </span>
                {p.externalId || p.rawSnippet ? (
                  <span className="break-all text-[12px] text-muted">
                    {p.externalId ? <span className="num">{p.externalId}</span> : null}
                    {p.externalId && p.rawSnippet ? ', ' : null}
                    {p.rawSnippet ? <code>{p.rawSnippet}</code> : null}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
