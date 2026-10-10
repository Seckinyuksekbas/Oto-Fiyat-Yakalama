import type { DemoListing } from './generator';

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c]);

const tl = (n: number) => `${n.toLocaleString('tr-TR')} TL`;
const km = (n: number) => `${n.toLocaleString('tr-TR')} km`;
export const listingTitle = (l: DemoListing) => `${l.year} ${l.make} ${l.model} ${l.trim}`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
}

function card(l: DemoListing, broken: boolean): string {
  const id = escapeHtml(l.id);
  const attrs = `data-listing data-id="${id}" data-tramer="${l.tramerAmount ?? ''}" data-painted="${escapeHtml(l.paintedParts.join(','))}" data-changed="${escapeHtml(l.changedParts.join(','))}"`;
  if (broken) {
    // Sayfa yapısı değişmiş gibi: fiyat ve marka/model alanları yeni sınıf adlarıyla.
    return `<article class="listing-v2" ${attrs}><a class="link" href="/ilan/${id}"><h2 class="title">${escapeHtml(listingTitle(l))}</h2></a><span class="tutar">${tl(l.price)}</span></article>`;
  }
  return `<article class="listing" ${attrs}>
<a class="link" href="/ilan/${id}"><h2 class="title">${escapeHtml(listingTitle(l))}</h2></a>
<img class="photo" src="/img/${id}.jpg" alt="">
<span class="make-model">${escapeHtml(`${l.make} ${l.model} ${l.trim}`)}</span>
<span class="year">${l.year}</span><span class="km">${km(l.km)}</span><span class="price">${tl(l.price)}</span>
<span class="fuel">${escapeHtml(l.fuel)}</span><span class="transmission">${escapeHtml(l.transmission)}</span>
<span class="city">${escapeHtml(l.city)}</span><span class="color">${escapeHtml(l.color)}</span><span class="body">${escapeHtml(l.bodyType)}</span>
</article>`;
}

export function renderListPage(items: DemoListing[], page: number, hasNext: boolean, broken = false): string {
  const next = hasNext ? `<a rel="next" href="/ilanlar?sayfa=${page + 1}">Sonraki</a>` : '';
  return layout(`İlanlar - Sayfa ${page}`, `<main data-page="${page}" data-has-next="${hasNext}">${items.map((l) => card(l, broken)).join('\n')}</main>${next}`);
}

export function renderDetail(l: DemoListing): string {
  return layout(listingTitle(l), `<main class="detail" data-id="${escapeHtml(l.id)}"><h1>${escapeHtml(listingTitle(l))}</h1><p class="price">${tl(l.price)}</p><p class="km">${km(l.km)}</p></main>`);
}

export function renderCaptchaPage(): string {
  return `<!doctype html><html lang="tr"><body data-demo-blocked><h1>Güvenlik doğrulaması</h1><div class="g-recaptcha"></div></body></html>`;
}
