import { type Prisma, resolveUserPlan, type Listing, type ListingAnalysis } from '@oto/db';
import { startOfIstanbulDay, type MatchEvent } from '@oto/shared';
import { buildMatchPayload } from './payload';

/** pg_advisory_xact_lock(4243, hashtext(userId)): kullanıcı başına günlük limit kararı. 4242 = ilan eşleştirme. */
const USER_LOCK_NAMESPACE = 4243;
const DELIVERABLE = new Set(['IN_APP', 'TELEGRAM']);

export interface PlannedMatch {
  matchId: number;
  userId: string;
  profile: { id: string; name: string; channels: string[] };
  reason: MatchEvent;
  previousPrice: bigint | null;
}

export interface PlannedNotification {
  id: number;
  userId: string;
  channel: 'IN_APP' | 'TELEGRAM';
  status: 'PENDING' | 'SKIPPED_LIMIT';
}

/**
 * Eşleşmeyle AYNI transaction'da çalışır (çağıran açar). Kullanıcı kilitleri hashtext anahtar sırasıyla
 * tek ifadede alınır: aynı kullanıcıları kapsayan iki eşzamanlı eşleştirme birbirini kilitlemez (deadlock yok).
 * telegramEnabled=false (worker'da bot token yok) ise TELEGRAM kanalı hiç planlanmaz.
 */
export async function planNotifications(
  tx: Prisma.TransactionClient,
  input: { listing: Listing; analysis: ListingAnalysis; matches: PlannedMatch[]; now: Date; telegramEnabled: boolean },
): Promise<PlannedNotification[]> {
  const out: PlannedNotification[] = [];
  // Gerçek ilk-görülme NEW'i ilanın ilk analizidir; sonradan terfi eden NEW için olay anı analiz zamanıdır.
  const firstAnalysis = (await tx.listingAnalysis.count({ where: { listingId: input.listing.id, id: { lt: input.analysis.id } } })) === 0;
  const byUser = new Map<string, PlannedMatch[]>();
  for (const m of input.matches) byUser.set(m.userId, [...(byUser.get(m.userId) ?? []), m]);
  const userIds = [...byUser.keys()].sort();
  // Tüm kilitler tek ifadede, GERÇEK anahtara (hashtext) göre sıralı alınır: iki eşzamanlı eşleştirme birbirini kilitlemez.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${USER_LOCK_NAMESPACE}::int, s.k) FROM (SELECT DISTINCT hashtext(u) AS k FROM unnest(${userIds}::text[]) AS u) s ORDER BY s.k`;
  // Saat kilitlerden SONRA alınır (now() işlem başlangıcıdır); kota günü ile satır zaman damgası aynı değerden gelir.
  const [{ now: dbNow }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  const dayStart = startOfIstanbulDay(dbNow);
  for (const userId of userIds) {
    const plan = await resolveUserPlan(tx, userId, input.now);
    const verified = await tx.notificationChannel.findMany({ where: { userId, isEnabled: true, isVerified: true }, select: { type: true } });
    const open = new Set<string>(['IN_APP', ...verified.map((c) => c.type)]);
    const allowed = new Set<string>(['IN_APP', ...plan.limits.channels]);
    let usedToday = await tx.notification.count({
      where: { userId, kind: 'MATCH', channel: { not: 'IN_APP' }, status: { not: 'SKIPPED_LIMIT' }, NOT: { status: 'FAILED', lastError: 'USER_INACTIVE' }, createdAt: { gte: dayStart } },
    });
    for (const m of byUser.get(userId)!) {
      const channels = [...new Set(['IN_APP', ...m.profile.channels])].filter(
        (c) => DELIVERABLE.has(c) && allowed.has(c) && open.has(c),
      ).filter((c) => c !== 'TELEGRAM' || input.telegramEnabled) as Array<'IN_APP' | 'TELEGRAM'>;
      const external = channels.filter((c) => c !== 'IN_APP');
      const statuses = new Map<string, 'PENDING' | 'SKIPPED_LIMIT'>();
      for (const c of external) {
        if (usedToday < plan.limits.maxNotificationsPerDay) {
          statuses.set(c, 'PENDING');
          usedToday += 1;
        } else statuses.set(c, 'SKIPPED_LIMIT');
      }
      const limitExceeded = [...statuses.values()].includes('SKIPPED_LIMIT');
      const payload = buildMatchPayload({
        listing: input.listing, analysis: input.analysis, reason: m.reason, previousPrice: m.previousPrice,
        profile: { id: m.profile.id, name: m.profile.name }, limitExceeded, firstAnalysis,
      });
      for (const c of channels) {
        const status = c === 'IN_APP' ? 'PENDING' : statuses.get(c)!;
        const rows = await tx.$queryRaw<{ id: number }[]>`
          INSERT INTO "Notification" ("userId", "matchId", "kind", "channel", "status", "payload", "createdAt")
          VALUES (${userId}, ${m.matchId}::int, 'MATCH'::"NotificationKind", ${c}::"ChannelType", ${status}::"NotificationStatus", ${JSON.stringify(payload)}::jsonb, ${dbNow}::timestamptz)
          ON CONFLICT ("matchId", "channel") DO NOTHING
          RETURNING "id"`;
        if (rows[0]) out.push({ id: rows[0].id, userId, channel: c, status });
      }
    }
  }
  return out;
}
