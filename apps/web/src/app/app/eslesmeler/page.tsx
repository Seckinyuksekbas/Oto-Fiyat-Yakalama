'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { BellRing, Car } from 'lucide-react';
import { ConfidenceMeter } from '@/components/confidence-meter';
import { EmptyState } from '@/components/empty-state';
import { FilterSelect } from '@/components/filters-bar';
import { ScoreRing } from '@/components/score-ring';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { DiscountText } from '@/components/listing-card';
import { formatDiscount, formatKm, formatRelative, formatTl } from '@/lib/format';
import { apiErrorMessage } from '@/lib/messages';
import { MATCH_REASON_LABEL, NEXT_PAGE_ERROR, useMatches, useSearchProfileOptions, type MatchRow } from '@/lib/panel-queries';

function MatchItem({ m }: { m: MatchRow }) {
  const l = m.listing;
  const discount = formatDiscount(m.analysis.discountPct);
  return (
    <li className="relative flex gap-3 rounded-lg border border-border bg-surface p-3 transition-colors focus-within:border-border-strong hover:border-border-strong">
      <div className="h-16 w-20 shrink-0 overflow-hidden rounded-md bg-surface-2 sm:h-[72px] sm:w-24">
        {l.imageUrl ? (
          <img src={l.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-full object-cover" />
        ) : (
          <span className="grid size-full place-items-center text-border-strong">
            <Car aria-hidden className="size-5" />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge tone="accent">{MATCH_REASON_LABEL[m.reason]}</Badge>
          <span className="truncate text-xs text-muted">{m.profile.name}</span>
        </div>
        <h3 className="mt-1 truncate text-[15px] font-semibold">
          <Link href={`/app/ilan/${l.id}`} className="after:absolute after:inset-0 after:content-[''] hover:text-accent">
            {`${l.make} ${l.model} · ${l.year}`}
          </Link>
        </h3>
        <p className="tnum mt-0.5 flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-semibold">{formatTl(m.matchedPrice)}</span>
          {m.analysis.confidence === 'INSUFFICIENT' ? (
            discount && <span className="text-xs text-muted">{`${discount} (zayıf tahmin)`}</span>
          ) : (
            <DiscountText pct={m.analysis.discountPct} />
          )}
          <span className="text-xs text-muted">{[formatKm(l.km), l.city].filter(Boolean).join(' · ')}</span>
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <ConfidenceMeter confidence={m.analysis.confidence} comparableCount={0} compact />
          <span className="text-xs text-muted">{formatRelative(m.createdAt)}</span>
          {l.status === 'REMOVED' && <Badge tone="danger">Yayından kalktı</Badge>}
        </div>
      </div>
      <ScoreRing score={m.analysis.opportunityScore} size={44} />
    </li>
  );
}

export default function MatchesPage() {
  const [profileId, setProfileId] = useState<string>();
  const [reason, setReason] = useState<string>();
  const [confidence, setConfidence] = useState<string>();
  const [minScore, setMinScore] = useState<string>();
  const profiles = useSearchProfileOptions();
  const filters = { profileId, reason, confidence, minScore };
  const q = useMatches(filters);
  const rows = useMemo(() => {
    const seen = new Set<number>();
    return (q.data?.pages ?? []).flatMap((p) => p.items).filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  }, [q.data]);
  const filtered = Object.values(filters).some(Boolean);

  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-5">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Eşleşmeler</h1>
        <p className="mt-1 text-sm text-muted">Arama profillerinize uyan ilanlar, en yenisi üstte.</p>
      </header>

      <form
        aria-label="Eşleşme filtreleri"
        onSubmit={(e) => e.preventDefault()}
        className="grid gap-3 rounded-lg border border-border bg-surface p-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <FilterSelect
          label="Profil"
          value={profileId}
          onChange={setProfileId}
          options={(profiles.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
          allLabel="Tüm profiller"
        />
        <FilterSelect
          label="Neden"
          value={reason}
          onChange={setReason}
          options={Object.entries(MATCH_REASON_LABEL).map(([value, label]) => ({ value, label }))}
          allLabel="Tüm nedenler"
        />
        <FilterSelect
          label="Güven"
          value={confidence}
          onChange={setConfidence}
          options={[
            { value: 'MEDIUM', label: 'Orta' },
            { value: 'HIGH', label: 'Yüksek' },
          ]}
          allLabel="Tümü"
        />
        <FilterSelect
          label="En düşük skor"
          value={minScore}
          onChange={setMinScore}
          options={['60', '70', '80', '90'].map((v) => ({ value: v, label: `${v} ve üstü` }))}
          allLabel="Sınır yok"
        />
      </form>

      {q.isPending ? (
        <div aria-busy="true" aria-label="Eşleşmeler yükleniyor" className="grid gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
      ) : q.isError && !q.data ? (
        <EmptyState
          title="Eşleşmeler yüklenemedi"
          description={apiErrorMessage(q.error)}
          action={<Button onClick={() => void q.refetch()}>Yeniden dene</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<BellRing className="size-5" />}
          title={filtered ? 'Bu filtrelerle eşleşme yok' : 'Henüz eşleşme yok'}
          description={
            filtered
              ? 'Filtreleri değiştirerek daha geniş bir liste görebilirsiniz.'
              : 'Bir arama profili oluşturun; uyan ilanlar çıktığında burada ve bildirimlerinizde görünür.'
          }
          action={
            filtered ? undefined : (
              <Button asChild>
                <Link href="/app/profiller/yeni">Profil oluştur</Link>
              </Button>
            )
          }
        />
      ) : (
        <>
          <ul className="grid gap-3">
            {rows.map((m) => (
              <MatchItem key={m.id} m={m} />
            ))}
          </ul>
          {q.isFetchNextPageError && (
            <p role="alert" className="text-center text-sm text-danger-text">
              {NEXT_PAGE_ERROR}
            </p>
          )}
          {q.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="secondary" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                {q.isFetchingNextPage ? 'Yükleniyor…' : q.isFetchNextPageError ? 'Tekrar dene' : 'Daha fazla yükle'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
