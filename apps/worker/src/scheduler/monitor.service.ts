import { Injectable, Logger } from '@nestjs/common';
import { alertThresholdsSchema, DEFAULT_ALERT_THRESHOLDS, type AlertThresholds } from '@oto/shared';
import { AlertService } from '../common/alert.service';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import { TELEGRAM_UNAUTHORIZED_FLAG } from '../notifications/notify.service';
import { QueueRegistry } from '../queues/queue-registry';

export const ALERT_THRESHOLDS_KEY = 'alerts.thresholds';
const HOUR_MS = 60 * 60 * 1000;
/** Bildirim hata oranı en az bu kadar sonuçlanmış (SENT+FAILED) bildirimle değerlendirilir; tek hata %100 sayılmasın. */
export const NOTIFY_FAILURE_MIN_SAMPLE = 10;
const SCAN_COUNT = 200;
/** Kayıp worker alarmı (worker + son nabız anı başına) bir kez verilir; seen kaydının ömrü kadar hatırlanır. */
const WORKER_LOST_FLAG_PREFIX = 'monitor:worker-lost:';
const WORKER_LOST_FLAG_SEC = 24 * 60 * 60;

/**
 * Scheduler'ın her tick'inde alarm koşullarını değerlendirir (spec §9) ve `AlertService.raise` ile bildirir (30 dk susturma,
 * `dedupeLog`: koşul sürdükçe log çoğalmaz). Eşikler `alerts.thresholds` ayarından HER tick'te okunur (tek PK sorgusu):
 * admin değişikliği bir sonraki tick'te etkilidir, önbellek/abonelik gerekmez. Geçersiz kayıt varsayılanlara düşer.
 *
 * `match-dispatch-stuck` burada değil, satır bazında AnalysisSweepService'te (aynı AlertService üzerinden) verilir.
 */
@Injectable()
export class MonitorService {
  private readonly logger = new Logger(MonitorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queues: QueueRegistry,
    private readonly alerts: AlertService,
  ) {}

  async thresholds(): Promise<AlertThresholds> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: ALERT_THRESHOLDS_KEY } });
    if (!row) return DEFAULT_ALERT_THRESHOLDS;
    const parsed = alertThresholdsSchema.safeParse(row.value);
    if (parsed.success) return parsed.data;
    this.logger.warn(`Geçersiz ${ALERT_THRESHOLDS_KEY}; varsayılan eşikler kullanılıyor: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    return DEFAULT_ALERT_THRESHOLDS;
  }

  /** Koşulu sağlanan alarm anahtarlarını döner (susturulmuş olsalar da). Bir koşulun hatası diğerlerini durdurmaz. */
  async check(now: Date = new Date()): Promise<string[]> {
    const t = await this.thresholds();
    const raised: string[] = [];
    const steps: Array<[string, () => Promise<void>]> = [
      ['sources', () => this.checkSources(raised)],
      ['parse-rate', () => this.checkParseRate(now, t, raised)],
      ['queue-depth', () => this.checkQueueDepth(t, raised)],
      ['notify-failure', () => this.checkNotifyFailure(now, t, raised)],
      ['workers', () => this.checkWorkers(now, t, raised)],
      ['telegram', () => this.checkTelegram(raised)],
    ];
    for (const [name, fn] of steps) {
      try {
        await fn();
      } catch (err) {
        this.logger.error(`İzleme adımı başarısız (${name}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return raised;
  }

  private async raise(raised: string[], key: string, level: 'WARN' | 'ERROR', message: string, context?: Record<string, unknown>): Promise<boolean> {
    raised.push(key);
    return this.alerts.raise({ key, level, component: 'monitor', message, context, dedupeLog: true });
  }

  /** Etkin (admin tarafından duraklatılmamış) ama DOWN ya da engel nedeniyle PAUSED kaynaklar. */
  private async checkSources(raised: string[]): Promise<void> {
    const rows = await this.prisma.dataSource.findMany({
      where: { isActive: true, health: { in: ['DOWN', 'PAUSED'] } },
      select: { id: true, name: true, health: true, consecutiveFailures: true },
      orderBy: { id: 'asc' },
    });
    for (const s of rows) {
      if (s.health === 'DOWN') {
        await this.raise(raised, `source:${s.id}:down`, 'ERROR', `${s.name} kaynağı DOWN (${s.consecutiveFailures} ardışık hata).`, { sourceId: s.id });
      } else {
        await this.raise(raised, `source:${s.id}:paused`, 'ERROR', `${s.name} kaynağı engel sinyali nedeniyle duraklatıldı; inceleme bekliyor.`, { sourceId: s.id });
      }
    }
  }

  /** Son 1 saatte kaynak başına PARSE hatası / çekilen sayfa > eşik. */
  private async checkParseRate(now: Date, t: AlertThresholds, raised: string[]): Promise<void> {
    const since = new Date(now.getTime() - HOUR_MS);
    const rows = await this.prisma.$queryRaw<Array<{ id: number; name: string; errors: number; pages: number }>>`
      SELECT s.id, s.name, e.errors::int AS errors, COALESCE(j.pages, 0)::int AS pages
      FROM (SELECT "sourceId", count(*) AS errors FROM "ScrapeError" WHERE kind = 'PARSE' AND "createdAt" >= ${since} GROUP BY "sourceId") e
      JOIN "DataSource" s ON s.id = e."sourceId"
      LEFT JOIN (SELECT "sourceId", sum("pagesFetched") AS pages FROM "CollectionJob" WHERE "createdAt" >= ${since} AND "dryRun" = false GROUP BY "sourceId") j
        ON j."sourceId" = e."sourceId"
      ORDER BY s.id`;
    for (const r of rows) {
      const rate = r.errors / Math.max(r.pages, 1);
      if (rate > t.parserErrorRate) {
        await this.raise(raised, `source:${r.id}:parse-rate`, 'WARN', `${r.name}: son 1 saatte ayrıştırma hata oranı %${Math.round(rate * 100)} (${r.errors} hata / ${r.pages} sayfa).`, {
          sourceId: r.id, errors: r.errors, pages: r.pages, threshold: t.parserErrorRate,
        });
      }
    }
  }

  /** `notify` + `notify-telegram` kuyruklarında bekleyen (waiting + prioritized + delayed) iş sayısı > eşik. */
  private async checkQueueDepth(t: AlertThresholds, raised: string[]): Promise<void> {
    const counts = await Promise.all([this.queues.notify, this.queues.notifyTelegram].map((q) => q.getJobCounts('waiting', 'prioritized', 'delayed')));
    const depth = counts.reduce((sum, c) => sum + (c.waiting ?? 0) + (c.prioritized ?? 0) + (c.delayed ?? 0), 0);
    if (depth > t.notifyQueueDepth) {
      await this.raise(raised, 'queue:notify:depth', 'WARN', `Bildirim kuyruklarında ${depth} iş bekliyor (eşik ${t.notifyQueueDepth}).`, { depth, threshold: t.notifyQueueDepth });
    }
  }

  /** Son 1 saatte FAILED / (SENT + FAILED) > eşik; askıya alma kaynaklı (USER_INACTIVE) iptaller teslim hatası sayılmaz. */
  private async checkNotifyFailure(now: Date, t: AlertThresholds, raised: string[]): Promise<void> {
    const since = new Date(now.getTime() - HOUR_MS);
    const [row] = await this.prisma.$queryRaw<Array<{ sent: number; failed: number }>>`
      SELECT count(*) FILTER (WHERE status = 'SENT')::int AS sent,
             count(*) FILTER (WHERE status = 'FAILED' AND "lastError" IS DISTINCT FROM 'USER_INACTIVE')::int AS failed
      FROM "Notification" WHERE "createdAt" >= ${since} AND status IN ('SENT', 'FAILED')`;
    const total = row.sent + row.failed;
    if (total < NOTIFY_FAILURE_MIN_SAMPLE) return;
    const rate = row.failed / total;
    if (rate > t.notifyFailureRate) {
      await this.raise(raised, 'notify:failure-rate', 'ERROR', `Son 1 saatte bildirim hata oranı %${Math.round(rate * 100)} (${row.failed}/${total}).`, {
        sent: row.sent, failed: row.failed, threshold: t.notifyFailureRate,
      });
    }
  }

  /** `worker:seen:<host>:<pid>` var, `worker:heartbeat:<host>:<pid>` yok ve son nabız heartbeatMissSec'ten eski: worker kayıp. */
  private async checkWorkers(now: Date, t: AlertThresholds, raised: string[]): Promise<void> {
    const seenKeys = await this.scan('worker:seen:*');
    for (const seenKey of seenKeys.sort()) {
      const id = seenKey.slice('worker:seen:'.length);
      if ((await this.redis.exists(`worker:heartbeat:${id}`)) === 1) continue;
      const raw = await this.redis.get(seenKey);
      if (!raw) continue;
      let info: { at?: string; role?: string };
      try {
        info = JSON.parse(raw) as { at?: string; role?: string };
      } catch {
        continue;
      }
      const at = Date.parse(info.at ?? '');
      if (!Number.isFinite(at) || now.getTime() - at <= t.heartbeatMissSec * 1000) continue;
      const ageSec = Math.round((now.getTime() - at) / 1000);
      const flag = `${WORKER_LOST_FLAG_PREFIX}${id}:${info.at}`;
      if ((await this.redis.exists(flag)) === 1) continue;
      const delivered = await this.raise(raised, `worker:${id}:lost`, 'ERROR', `Worker ${id} (${info.role ?? '?'}) ${ageSec} sn'dir nabız göndermiyor.`, { worker: id, role: info.role, lastSeenAt: info.at });
      // Ölü worker'ın seen kaydı 24 saat durur: aynı kayıp 30 dk'da bir yinelenmesin, bir kez bildirilsin.
      if (delivered) await this.redis.set(flag, '1', 'EX', WORKER_LOST_FLAG_SEC);
    }
  }

  private async checkTelegram(raised: string[]): Promise<void> {
    const at = await this.redis.get(TELEGRAM_UNAUTHORIZED_FLAG);
    if (!at) return;
    await this.raise(raised, 'telegram:unauthorized', 'ERROR', 'Telegram bot token geçersiz (401); Telegram bildirimleri gönderilemiyor.', { lastSeenAt: at });
  }

  private async scan(pattern: string): Promise<string[]> {
    const out: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
      cursor = next;
      out.push(...keys);
    } while (cursor !== '0');
    return [...new Set(out)];
  }
}
