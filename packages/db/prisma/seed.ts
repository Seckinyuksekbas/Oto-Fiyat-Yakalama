import { PrismaClient } from '@prisma/client';
import { seedPlans, seedSuperAdmin } from '../src/seed-data';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await seedPlans(prisma);
    const email = process.env.SEED_ADMIN_EMAIL;
    const password = process.env.SEED_ADMIN_PASSWORD;
    if (email && password) {
      await seedSuperAdmin(prisma, { email, password, name: 'Süper Admin' });
      console.log(`Süper admin hazır: ${email}`);
    } else {
      console.warn('SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD tanımlı değil; süper admin oluşturulmadı.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
