import { Controller, Get, Param } from '@nestjs/common';
import type { CatalogMakes, CatalogModels } from '@oto/shared';
import { Errors } from '../../common/errors/app-error';
import { RedisService } from '../../infra/redis.service';
import { CatalogRepository } from './catalog.repository';

const TTL_SECONDS = 600;

/** fold_tr SQL işleviyle aynı katlama (Türkçe harfler → ASCII, küçük harf). */
export function foldTr(s: string): string {
  const from = 'İIıĞğÜüŞşÖöÇç';
  const to = 'iiigguussoocc';
  let out = '';
  for (const ch of s) {
    const i = from.indexOf(ch);
    out += i >= 0 ? to[i] : ch;
  }
  return out.toLowerCase();
}

@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly repo: CatalogRepository,
    private readonly redis: RedisService,
  ) {}

  @Get('makes')
  async makes(): Promise<CatalogMakes> {
    return this.cached('catalog:makes', async () => ({ items: await this.repo.makes() }));
  }

  @Get('makes/:make/models')
  async models(@Param('make') make: string): Promise<CatalogModels> {
    const trimmed = make.trim();
    if (trimmed.length < 1 || trimmed.length > 40) throw Errors.validation([{ path: 'make', message: 'Geçersiz marka' }]);
    return this.cached(`catalog:models:${foldTr(trimmed)}`, async () => ({ items: await this.repo.models(trimmed) }));
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    try {
      const hit = await this.redis.get(key);
      if (hit) return JSON.parse(hit) as T;
    } catch {
      // önbellek okunamazsa veritabanından devam edilir
    }
    const value = await load();
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', TTL_SECONDS);
    } catch {
      // önbellek yazılamazsa yanıt yine de döner
    }
    return value;
  }
}
