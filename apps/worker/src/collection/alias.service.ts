import { Injectable } from '@nestjs/common';
import { createAliasResolver, type MakeModelResolver } from '@oto/collection';
import { PrismaService } from '../infra/prisma.service';

const CACHE_MS = 5 * 60 * 1000;

@Injectable()
export class AliasService {
  private cache?: { at: number; resolver: MakeModelResolver };

  constructor(private readonly prisma: PrismaService) {}

  async resolver(now = Date.now()): Promise<MakeModelResolver> {
    if (this.cache && now - this.cache.at < CACHE_MS) return this.cache.resolver;
    const rows = await this.prisma.makeModelAlias.findMany();
    const resolver = createAliasResolver(rows);
    this.cache = { at: now, resolver };
    return resolver;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}
