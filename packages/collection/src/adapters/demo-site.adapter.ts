import * as cheerio from 'cheerio';
import { z } from 'zod';
import type { AdapterContext, ListPage, ParseResult, SourceAdapter } from '../adapter';
import { FetchError } from '../errors';
import type { ListingProblem, RawListing } from '../types';

const configSchema = z.object({
  baseUrl: z.string().url(),
  maxPages: z.number().int().min(1).max(1000).default(200),
});

const csv = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

/** Yerel demo ilan sitesi (apps/demo-site). İzin türü: TEST. */
export class DemoSiteAdapter implements SourceAdapter {
  readonly key = 'demo-site';
  readonly kind = 'HTTP' as const;

  async *listPages(ctx: AdapterContext): AsyncIterable<ListPage> {
    const cfg = configSchema.parse(ctx.config);
    for (let pageNo = 1; pageNo <= cfg.maxPages; pageNo++) {
      const url = new URL(`/ilanlar?sayfa=${pageNo}`, cfg.baseUrl).toString();
      const res = await ctx.http.getText(url);
      if (res.status !== 200) {
        throw new FetchError(res.status >= 500 ? 'HTTP_5XX' : 'HTTP_4XX', `Liste sayfası alınamadı (HTTP ${res.status}): ${url}`, url, false);
      }
      const isLast = cheerio.load(res.body)('main').attr('data-has-next') !== 'true';
      yield { url, pageNo, html: res.body, isLast };
      if (isLast) return;
    }
  }

  parseList(page: ListPage): ParseResult {
    const $ = cheerio.load(page.html);
    const listings: RawListing[] = [];
    const problems: ListingProblem[] = [];
    $('[data-listing]').each((_i, el) => {
      const card = $(el);
      const text = (selector: string) => card.find(selector).first().text().trim();
      const externalId = card.attr('data-id')?.trim() ?? '';
      const href = card.find('a.link').attr('href') ?? '';
      const required = { externalId, href, title: text('.title'), price: text('.price'), makeModel: text('.make-model') };
      const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
      if (missing.length > 0) {
        problems.push({
          externalId: externalId || undefined,
          field: missing.join(','),
          problem: 'kartta zorunlu alan yok',
          rawSnippet: ($.html(el) ?? '').slice(0, 300),
        });
        return;
      }
      const image = card.find('img.photo').attr('src');
      listings.push({
        externalId,
        url: new URL(href, page.url).toString(),
        title: required.title,
        makeModelText: required.makeModel,
        year: text('.year'),
        km: text('.km'),
        price: required.price,
        fuel: text('.fuel'),
        transmission: text('.transmission'),
        city: text('.city') || null,
        color: text('.color') || null,
        bodyType: text('.body') || null,
        sellerType: null,
        imageUrl: image ? new URL(image, page.url).toString() : null,
        damage: {
          tramerAmount: card.attr('data-tramer') || null,
          paintedParts: csv(card.attr('data-painted')),
          changedParts: csv(card.attr('data-changed')),
        },
      });
    });
    return { listings, problems };
  }

  isBlockedPage(html: string): boolean {
    return html.includes('data-demo-blocked');
  }
}
