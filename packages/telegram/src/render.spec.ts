import type { MatchNotificationPayload } from '@oto/shared';
import { describe, expect, it } from 'vitest';
import { formatIstanbulDateTime, formatTl, isPublicHttpUrl } from './format';
import { renderMatchMessage } from './render';

const base: MatchNotificationPayload = {
  type: 'MATCH', reason: 'NEW', profile: { id: 'p1', name: 'BMW' },
  listing: { id: 7, title: 'Temiz <320i>', make: 'BMW', model: '3 Serisi', trim: '320i', year: 2019, km: 85000, fuel: 'GASOLINE',
    transmission: 'AUTOMATIC', city: 'İstanbul', price: '960000', imageUrl: null, url: 'https://ornek.com/ilan/7', firstSeenAt: '2026-10-10T11:32:00.000Z' },
  analysis: { opportunityScore: 77, confidence: 'HIGH', estimatedPrice: '1200000', priceDiff: '240000', discountPct: 0.2, comparableCount: 14 },
  previousPrice: null, limitExceeded: false,
};
const opts = { publicBaseUrl: 'https://otofirsat.example' };

describe('format', () => {
  it('formats money, Istanbul time and public urls', () => {
    expect(formatTl('960000')).toBe('960.000');
    expect(formatTl(1_010_000n)).toBe('1.010.000');
    expect(formatIstanbulDateTime('2026-10-10T11:32:00.000Z')).toBe('10.10.2026 14:32');
    expect(isPublicHttpUrl('https://ornek.com/x')).toBe(true);
    expect(isPublicHttpUrl('http://127.0.0.1:4000/x')).toBe(false);
    expect(isPublicHttpUrl('http://localhost:3000/x')).toBe(false);
    expect(isPublicHttpUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('renderMatchMessage', () => {
  it('renders the spec reference message (§5.5)', () => {
    const m = renderMatchMessage(base, opts);
    expect(m.text).toBe(
      [
        '🔥 <b>Fırsat</b> · Skor 77 · Güven: Yüksek',
        '<b>BMW 3 Serisi 320i · 2019</b>',
        '💰 960.000 TL   (Piyasa ≈ 1.200.000 TL)',
        '📉 240.000 TL altında · %20',
        '🛣 85.000 km · Benzin · Otomatik · İstanbul',
        '📊 14 benzer ilan ile karşılaştırıldı',
        '🕒 İlk görülme: 10.10.2026 14:32',
        '',
        '<i>Fiyat analizi tahminidir; aracın durumunu garanti etmez.</i>',
      ].join('\n'),
    );
    expect(m.photoUrl).toBeNull();
    expect(m.replyMarkup).toEqual({
      inline_keyboard: [[
        { text: 'İlana git', url: 'https://ornek.com/ilan/7' },
        { text: 'Favorile', callback_data: 'fav:7' },
        { text: 'Analizi gör', url: 'https://otofirsat.example/ilan/7' },
      ]],
    });
  });

  it('price drop and relist headers', () => {
    expect(renderMatchMessage({ ...base, reason: 'PRICE_DROP', previousPrice: '1010000' }, opts).text.split('\n')[0])
      .toBe('📉 <b>Fiyat düştü: 1.010.000 → 960.000 TL</b> · Skor 77 · Güven: Yüksek');
    expect(renderMatchMessage({ ...base, reason: 'RELIST' }, opts).text.split('\n')[0]).toBe('🔁 <b>Yeniden yayında</b> · Skor 77 · Güven: Yüksek');
  });

  it('weak analysis: "Yeni ilan" header, no discount/market lines', () => {
    const m = renderMatchMessage({ ...base, analysis: { opportunityScore: 12, confidence: 'INSUFFICIENT', estimatedPrice: null, priceDiff: null, discountPct: null, comparableCount: 2 } }, opts);
    const lines = m.text.split('\n');
    expect(lines[0]).toBe('🆕 <b>Yeni ilan</b> · Skor 12 · Güven: Yetersiz');
    expect(lines[2]).toBe('💰 960.000 TL');
    expect(m.text).not.toContain('altında');
    expect(m.text).toContain('📊 2 benzer ilan ile karşılaştırıldı');
  });

  it('escapes HTML, omits null city, local urls and uses photo when present', () => {
    const m = renderMatchMessage({ ...base, listing: { ...base.listing, trim: null, city: null, url: 'http://127.0.0.1:4000/ilan/7', imageUrl: 'https://img.example/7.jpg', title: '<b>x</b>' } }, { publicBaseUrl: 'http://localhost:3000' });
    expect(m.text).toContain('<b>BMW 3 Serisi · 2019</b>');
    expect(m.text).toContain('🛣 85.000 km · Benzin · Otomatik\n');
    expect(m.photoUrl).toBe('https://img.example/7.jpg');
    expect(m.replyMarkup).toEqual({ inline_keyboard: [[{ text: 'Favorile', callback_data: 'fav:7' }]] });
  });

  it('escapes make and never includes the listing title', () => {
    expect(renderMatchMessage({ ...base, listing: { ...base.listing, make: 'A<B' } }, opts).text).toContain('A&lt;B');
    expect(renderMatchMessage(base, opts).text).not.toContain('Temiz');
  });
});
