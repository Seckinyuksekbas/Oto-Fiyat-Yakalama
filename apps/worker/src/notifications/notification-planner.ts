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
 * Eşleşmeyle AYNI transaction'da çalışır (çağıran açar). Kullanıcı kilitleri id sırasıyla alınır:
 * aynı kullanıcıları kapsayan iki eşzamanlı eşleştirme birbirini kilitlemez (deadlock yok).
 */
export async function planNotifications(
  tx: Prisma.TransactionClient,
  input: { listing: Listing; analysis: ListingAnalysis; matches: PlannedMatch[]; now: Date },
): Promise<PlannedNotification[]> {
  const out: PlannedNotification[] = [];
  const byUser = new Map<string, PlannedMatch[]>();
  for (const m of input.matches) byUser.set(m.userId, [...(byUser.get(m.userId) ?? []), m]);
  const userIds = [...byUser.keys()].sort();
  for (const userId of userIds) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${USER_LOCK_NAMESPACE}::int, hashtext(${userId}))`;
  }
  const dayStart = startOfIstanbulDay(input.now);
  for (const userId of userIds) {
    const plan = await resolveUserPlan(tx, userId, input.now);
    const verified = await tx.notificationChannel.findMany({ where: { userId, isEnabled: true, isVerified: true }, select: { type: true } });
    const open = new Set<string>(['IN_APP', ...verified.map((c) => c.type)]);
    const allowed = new Set<string>(['IN_APP', ...plan.limits.channels]);
    let usedToday = await tx.notification.count({
      where: { userId, kind: 'MATCH', channel: { not: 'IN_APP' }, status: { not: 'SKIPPED_LIMIT' }, createdAt: { gte: dayStart } },
    });
    for (const m of byUser.get(userId)!) {
      const channels = [...new Set(['IN_APP', ...m.profile.channels])].filter(
        (c) => DELIVERABLE.has(c) && allowed.has(c) && open.has(c),
      ) as Array<'IN_APP' | 'TELEGRAM'>;
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
        profile: { id: m.profile.id, name: m.profile.name }, limitExceeded,
      });
      for (const c of channels) {
        const status = c === 'IN_APP' ? 'PENDING' : statuses.get(c)!;
        const rows = await tx.$queryRaw<{ id: number }[]>`
          INSERT INTO "Notification" ("userId", "matchId", "kind", "channel", "status", "payload")
          VALUES (${userId}, ${m.matchId}::int, 'MATCH'::"NotificationKind", ${c}::"ChannelType", ${status}::"NotificationStatus", ${JSON.stringify(payload)}::jsonb)
          ON CONFLICT ("matchId", "channel") DO NOTHING
          RETURNING "id"`;
        if (rows[0]) out.push({ id: rows[0].id, userId, channel: c, status });
      }
    }
  }
  return out;
}
