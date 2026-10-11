import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@oto/db';
import { redactSecrets } from '@oto/server-common';
import {
  ErrorCode,
  NOTIFY_JOB_OPTS,
  notifyJobId,
  type AdminNotificationLatencyQuery,
  type AdminNotificationsQuery,
  type NotifyJobData,
} from '@oto/shared';
import type { Queue } from 'bullmq';
import type { AuditCtx } from '../../common/audit/audit-ctx.decorator';
import { AuditService, type AuditTarget } from '../../common/audit/audit.service';
import { AppError } from '../../common/errors/app-error';
import { AdminQueues } from '../../infra/admin-queues.service';
import { PrismaService } from '../../infra/prisma.service';

export type RetrySkipReason = 'NOT_FOUND' | 'NOT_FAILED' | 'USER_INACTIVE' | 'NOT_ADMIN' | 'UNSUPPORTED_CHANNEL' | 'TOO_OLD' | 'JOB_IN_FLIGHT';
export interface RetryResult {
  retried: number[];
  skipped: Array<{ id: number; reason: RetrySkipReason }>;
}

export interface Pct {
  p50: number | null;
  p95: number | null;
  n: number;
}
interface PctRow {
  key: string | null;
  p50: number | null;
  p95: number | null;
  n: number;
}

const RANGE_MS = { '24h': 24 * 60 * 60_000, '7d': 7 * 24 * 60 * 60_000 } as const;
const REASONS = ['NEW', 'PRICE_DROP', 'RELIST'] as const;
const CHANNELS = ['IN_APP', 'TELEGRAM', 'EMAIL'] as const;
/** Kuyruk işçisi olan kanallar (EMAIL için işçi yok). */
const DISPATCHABLE = new Set(['IN_APP', 'TELEGRAM']);
const TITLE_MAX = 200;
/** Bu yaştan eski bildirim yeniden denenmez (NOTIFY_JOB_OPTS.removeOnFail penceresi; olay artık bayat). */
export const RETRY_MAX_AGE_MS = NOTIFY_JOB_OPTS.removeOnFail.age * 1000;

const unavailable = () => new AppError(ErrorCode.INTERNAL, 503, 'Bildirim kuyruğuna şu anda erişilemiyor');

@Injectable()
export class AdminNotificationsService {
  private readonly logger = new Logger(AdminNotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: AdminQueues,
    private readonly audit: AuditService,
  ) {}

  /** Kanal yapılandırması / chatId / tam payload döndürülmez: yalnızca başlık ve neden özeti. */
  async list(q: AdminNotificationsQuery) {
    const where: Prisma.NotificationWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.channel ? { channel: q.channel } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.notification.count({ where }),
      this.prisma.notification.findMany({
        where,
        include: { user: { select: { email: true, status: true } } },
        orderBy: { id: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return {
      total,
      items: rows.map((n) => ({
        id: n.id,
        userId: n.userId,
        userEmail: n.user.email,
        userStatus: n.user.status,
        kind: n.kind,
        channel: n.channel,
        status: n.status,
        attempts: n.attempts,
        lastError: n.lastError === null ? null : redactSecrets(n.lastError),
        ...summarize(n.kind, n.payload),
        createdAt: n.createdAt.toISOString(),
        queuedAt: n.queuedAt?.toISOString() ?? null,
        sentAt: n.sentAt?.toISOString() ?? null,
        latencyMs: n.latencyMs,
      })),
    };
  }

  /**
   * Yalnızca FAILED, `USER_INACTIVE` olmayan, kullanıcısı ACTIVE olan (SYSTEM_ALERT için hâlâ admin olan; değilse `NOT_ADMIN`), kuyruk kanalındaki (IN_APP/TELEGRAM) ve 7 günden
   * yeni (removeOnFail penceresi; daha eski olay bayattır → `TOO_OLD`) satırlar.
   * 1) `notify-<id>` işinin durumu okunur: bitmiş (failed/completed) iş kaldırılır — yoksa aynı jobId ile ekleme sessizce
   *    yok sayılır; bekleyen/aktif/gecikmeli iş varsa satır `JOB_IN_FLIGHT` atlanır (o iş satırı zaten işleyebilir).
   *    Redis kapalıysa burada 503 (DB'ye dokunulmadan).
   * 2) Tek transaction'da koşullu `UPDATE … RETURNING` (status = FAILED koşulu): eşzamanlı ikinci tıklama satırı
   *    bulamaz ve `NOT_FAILED` atlar — çift gönderim yok. Denetim aynı transaction'da, yalnızca değişen satırlar için
   *    (`auditTarget` verilirse onun hedefiyle — kuyruk düzeyi retry-failed bunu kullanır).
   * 3) Commit sonrası `notify-<id>` jobId'siyle eklenir (idempotent) ve queuedAt yazılır. Ekleme başarısızsa satırlar
   *    PENDING/queuedAt=null kalır; scheduler bildirim süpürmesi onları yeniden kuyruğa alır.
   */
  async retry(ctx: AuditCtx, ids: number[], auditTarget?: (changedIds: number[]) => AuditTarget): Promise<RetryResult> {
    const order = [...new Set(ids)];
    const minCreatedAt = new Date(Date.now() - RETRY_MAX_AGE_MS);
    const rows = await this.prisma.notification.findMany({
      where: { id: { in: order } },
      select: { id: true, kind: true, status: true, channel: true, lastError: true, createdAt: true, user: { select: { status: true, role: true } } },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const skipped = new Map<number, RetrySkipReason>();
    const candidates: Array<{ id: number; channel: string }> = [];
    for (const id of order) {
      const r = byId.get(id);
      if (!r) skipped.set(id, 'NOT_FOUND');
      else if (r.status !== 'FAILED') skipped.set(id, 'NOT_FAILED');
      else if (r.lastError === 'USER_INACTIVE' || r.user.status !== 'ACTIVE') skipped.set(id, 'USER_INACTIVE');
      else if (r.kind === 'SYSTEM_ALERT' && r.user.role !== 'ADMIN' && r.user.role !== 'SUPER_ADMIN') skipped.set(id, 'NOT_ADMIN');
      else if (!DISPATCHABLE.has(r.channel)) skipped.set(id, 'UNSUPPORTED_CHANNEL');
      else if (r.createdAt < minCreatedAt) skipped.set(id, 'TOO_OLD');
      else candidates.push({ id, channel: r.channel });
    }

    const ready: Array<{ id: number; channel: string }> = [];
    for (const c of candidates) {
      if ((await this.clearFinishedJob(this.queueFor(c.channel), c.id)) === 'in-flight') skipped.set(c.id, 'JOB_IN_FLIGHT');
      else ready.push(c);
    }

    if (ready.length > 0) {
      const reset = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.$queryRaw<Array<{ id: number }>>`
          UPDATE "Notification" n
          SET status = 'PENDING', attempts = 0, "lastError" = NULL, "queuedAt" = NULL
          FROM "User" u
          WHERE n.id = ANY(${ready.map((c) => c.id)}::int[])
            AND n."userId" = u.id
            AND u.status = 'ACTIVE'
            AND n.status = 'FAILED'
            AND n."lastError" IS DISTINCT FROM 'USER_INACTIVE'
            AND (n.kind <> 'SYSTEM_ALERT' OR u.role IN ('ADMIN', 'SUPER_ADMIN'))
            AND n.channel IN ('IN_APP', 'TELEGRAM')
            AND n."createdAt" >= ${minCreatedAt}
          RETURNING n.id`;
        const changed = new Set(updated.map((u) => u.id));
        const changedIds = order.filter((id) => changed.has(id));
        if (changedIds.length > 0) {
          await this.audit.recordInTx(
            tx,
            ctx,
            auditTarget?.(changedIds) ?? {
              targetType: 'Notification',
              targetId: `bulk:${changedIds.length}`,
              before: { status: 'FAILED' },
              after: { ids: changedIds, status: 'PENDING' },
            },
          );
        }
        return changed;
      });

      for (const c of ready) if (!reset.has(c.id)) skipped.set(c.id, 'NOT_FAILED');
      await this.enqueue(ready.filter((c) => reset.has(c.id)));
    }

    const retried = order.filter((id) => !skipped.has(id));
    return { retried, skipped: order.filter((id) => skipped.has(id)).map((id) => ({ id, reason: skipped.get(id)! })) };
  }

  /** Son 24 saat / 7 gün SENT MATCH bildirimleri: `latencyMs` (= sentAt − eventAt) için Postgres percentile_cont. */
  async latency(q: AdminNotificationLatencyQuery) {
    const since = new Date(Date.now() - RANGE_MS[q.range]);
    const base = Prisma.sql`FROM "Notification" WHERE kind = 'MATCH' AND status = 'SENT' AND "latencyMs" IS NOT NULL AND "sentAt" >= ${since}`;
    const agg = Prisma.sql`percentile_cont(0.5) WITHIN GROUP (ORDER BY "latencyMs") AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs") AS p95, count(*)::int AS n`;
    const [reasons, channels] = await Promise.all([
      this.prisma.$queryRaw<PctRow[]>`SELECT payload->>'reason' AS key, ${agg} ${base} GROUP BY 1`,
      this.prisma.$queryRaw<PctRow[]>`SELECT channel::text AS key, ${agg} ${base} GROUP BY 1`,
    ]);
    return { range: q.range, byReason: bucket(REASONS, reasons), byChannel: bucket(CHANNELS, channels) };
  }

  private queueFor(channel: string): Queue<NotifyJobData> {
    return channel === 'TELEGRAM' ? this.queues.notifyTelegram : this.queues.notify;
  }

  /**
   * `notify-<id>` işi: yoksa 'none'; failed/completed ise silinir ve 'none'; bekleyen/aktif/gecikmeli/öncelikli ise
   * 'in-flight' (dokunulmaz, satır atlanır). Redis hatası 503.
   */
  private async clearFinishedJob(queue: Queue<NotifyJobData>, id: number): Promise<'none' | 'in-flight'> {
    try {
      const job = await queue.getJob(notifyJobId(id));
      if (!job) return 'none';
      const state = await job.getState();
      if (state === 'unknown') return 'none';
      if (state !== 'failed' && state !== 'completed') return 'in-flight';
      try {
        await job.remove();
      } catch {
        // Eşzamanlı istek kaldırmış olabilir; iş hâlâ bitmiş durumda duruyorsa yeni ekleme yok sayılacağından hata.
        const still = await queue.getJob(notifyJobId(id));
        if (still && ['failed', 'completed'].includes(await still.getState())) throw unavailable();
      }
      return 'none';
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw unavailable();
    }
  }

  private async enqueue(items: Array<{ id: number; channel: string }>): Promise<void> {
    const queued: number[] = [];
    for (const it of items) {
      try {
        await this.queueFor(it.channel).add('notify', { notificationId: it.id }, { jobId: notifyJobId(it.id), ...NOTIFY_JOB_OPTS });
        queued.push(it.id);
      } catch (err) {
        this.logger.warn(`Bildirim ${it.id} kuyruğa alınamadı; süpürme yeniden deneyecek: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (queued.length > 0) {
      await this.prisma.notification.updateMany({ where: { id: { in: queued }, status: 'PENDING' }, data: { queuedAt: new Date() } });
    }
  }
}

function bucket<K extends string>(keys: readonly K[], rows: PctRow[]): Record<K, Pct> {
  const out = {} as Record<K, Pct>;
  for (const k of keys) {
    const r = rows.find((x) => x.key === k);
    out[k] = r ? { p50: round(r.p50), p95: round(r.p95), n: r.n } : { p50: null, p95: null, n: 0 };
  }
  return out;
}

const round = (v: number | null) => (v === null ? null : Math.round(Number(v)));

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, TITLE_MAX) : null;
}

/** Payload'dan yalnızca güvenli özet alanları (başlık, neden); URL, profil, chatId vb. dışarıda kalır. */
function summarize(kind: string, payload: Prisma.JsonValue): { title: string | null; reason: string | null } {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  if (kind === 'MATCH') {
    const listing = p.listing && typeof p.listing === 'object' ? (p.listing as Record<string, unknown>) : {};
    return { title: str(listing.title), reason: str(p.reason) };
  }
  if (kind === 'SYSTEM_ALERT') return { title: str(p.title) ?? str(p.key) ?? str(p.type), reason: null };
  return { title: str(p.type), reason: null };
}
