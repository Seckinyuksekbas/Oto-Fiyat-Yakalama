import { Injectable } from '@nestjs/common';
import type { NormalizedProfile } from '@oto/shared';
import type { SearchProfile } from '@oto/db';
import { PrismaService } from '../../infra/prisma.service';

function toData(p: NormalizedProfile) {
  return {
    ...p,
    priceMin: p.priceMin === null ? null : BigInt(p.priceMin),
    priceMax: p.priceMax === null ? null : BigInt(p.priceMax),
    fuels: p.fuels as SearchProfile['fuels'],
    transmissions: p.transmissions as SearchProfile['transmissions'],
    channels: p.channels as SearchProfile['channels'],
  };
}

/** Arama profillerine TEK erişim noktası; her sorgu userId ile kapsamlıdır. */
@Injectable()
export class SearchProfilesRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string): Promise<SearchProfile[]> {
    return this.prisma.searchProfile.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  find(userId: string, id: string): Promise<SearchProfile | null> {
    return this.prisma.searchProfile.findFirst({ where: { id, userId } });
  }

  /** Kullanıcı başına advisory kilit altında sayar ve oluşturur; limit doluysa null. */
  createWithinLimit(userId: string, p: NormalizedProfile, max: number): Promise<SearchProfile | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`profiles:${userId}`}))`;
      if ((await tx.searchProfile.count({ where: { userId } })) >= max) return null;
      return tx.searchProfile.create({ data: { ...toData(p), userId } });
    });
  }

  async update(userId: string, id: string, p: NormalizedProfile): Promise<SearchProfile | null> {
    const res = await this.prisma.searchProfile.updateMany({ where: { id, userId }, data: toData(p) });
    return res.count === 1 ? this.find(userId, id) : null;
  }

  async setStatus(userId: string, id: string, status: 'ACTIVE' | 'PAUSED'): Promise<SearchProfile | null> {
    const res = await this.prisma.searchProfile.updateMany({ where: { id, userId }, data: { status } });
    return res.count === 1 ? this.find(userId, id) : null;
  }

  /** Sürdürme: ACTIVE profil sayısı (bu profil hariç) < max ise ACTIVE yapar; kilit altında. */
  resumeWithinLimit(userId: string, id: string, max: number): Promise<SearchProfile | null | 'LIMIT'> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`profiles:${userId}`}))`;
      const own = await tx.searchProfile.findFirst({ where: { id, userId } });
      if (!own) return null;
      if (own.status === 'ACTIVE') return own;
      if ((await tx.searchProfile.count({ where: { userId, status: 'ACTIVE' } })) >= max) return 'LIMIT' as const;
      return tx.searchProfile.update({ where: { id: own.id }, data: { status: 'ACTIVE' } });
    });
  }

  async delete(userId: string, id: string): Promise<boolean> {
    return (await this.prisma.searchProfile.deleteMany({ where: { id, userId } })).count === 1;
  }
}
