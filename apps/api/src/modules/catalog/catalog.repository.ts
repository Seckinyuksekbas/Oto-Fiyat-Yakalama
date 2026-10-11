import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma.service';

/** Katalog merkezi veridir (kullanıcıya özel değil); me/** dışında olduğundan Prisma doğrudan kullanılabilir. */
@Injectable()
export class CatalogRepository {
  constructor(private readonly prisma: PrismaService) {}

  makes(): Promise<Array<{ make: string; count: number }>> {
    return this.prisma.$queryRaw`
      SELECT make, count(*)::int AS count FROM "Listing" WHERE status = 'ACTIVE'
      GROUP BY make ORDER BY count DESC, make ASC LIMIT 200`;
  }

  models(make: string): Promise<Array<{ model: string; count: number }>> {
    return this.prisma.$queryRaw`
      SELECT model, count(*)::int AS count FROM "Listing"
      WHERE status = 'ACTIVE' AND fold_tr(make) = fold_tr(${make}::text)
      GROUP BY model ORDER BY count DESC, model ASC LIMIT 200`;
  }
}
