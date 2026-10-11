import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@oto/db';
import { PrismaService } from '../infra/prisma.service';

/** Saklama süreleri (gün). KVKK: kişisel veri içeren kayıtlar gerektiğinden uzun tutulmaz. */
export const RETENTION = {
  systemLogDays: 30,
  scrapeErrorDays: 30,
  listingIssueDays: 30,
  auditLogDays: 365,
  notificationDays: 90,
  sessionDays: 30,
  tokenDays: 7,
  analysisDays: 90,
} as const;

/** Tek DELETE ifadesinin sileceği en fazla satır: uzun kilit ve büyük WAL patlamalarını önler. */
export const RETENTION_BATCH = 5000;

const DAY_MS = 24 * 60 * 60 * 1000;

export type RetentionResult = Record<
  | 'systemLogs'
  | 'scrapeErrors'
  | 'listingIssues'
  | 'auditLogs'
  | 'notifications'
  | 'sessions'
  | 'emailVerificationTokens'
  | 'passwordResetTokens'
  | 'telegramLinkTokens'
  | 'analyses',
  number
>;

/** Silinebilecek tablolar (sabit liste; tablo adı asla dışarıdan gelmez). */
type Table =
  | 'SystemLog'
  | 'ScrapeError'
  | 'ListingIssue'
  | 'AuditLog'
  | 'Notification'
  | 'Session'
  | 'EmailVerificationToken'
  | 'PasswordResetToken'
  | 'TelegramLinkToken'
  | 'ListingAnalysis';

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Günlük temizlik. Tablo başına silinen satır sayısını döner. Tablolar sırayla (paralel değil) işlenir;
   * bir tablodaki hata loglanır ve diğer tablolar yine işlenir (o tablonun sayısı hataya kadar silinenlerdir).
   */
  async run(now: Date = new Date()): Promise<RetentionResult> {
    const before = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const created = (days: number) => Prisma.sql`t."createdAt" < ${before(days)}`;
    const usedOrExpired = (days: number) => Prisma.sql`(t."usedAt" < ${before(days)} OR t."expiresAt" < ${before(days)})`;
    const sessionCut = before(RETENTION.sessionDays);
    const r = {} as RetentionResult;
    const failed: string[] = [];

    const steps: Array<[keyof RetentionResult, Table, (add: (n: number) => void) => Promise<void>]> = [
      ['systemLogs', 'SystemLog', (add) => this.deleteBatched('SystemLog', created(RETENTION.systemLogDays), add)],
      ['scrapeErrors', 'ScrapeError', (add) => this.deleteBatched('ScrapeError', created(RETENTION.scrapeErrorDays), add)],
      ['listingIssues', 'ListingIssue', (add) => this.deleteBatched('ListingIssue', created(RETENTION.listingIssueDays), add)],
      ['auditLogs', 'AuditLog', (add) => this.deleteBatched('AuditLog', created(RETENTION.auditLogDays), add)],
      // Notification → ListingMatch FK'si bildirimden eşleşmeye doğrudur: bildirim silmek eşleşmeye dokunmaz.
      ['notifications', 'Notification', (add) => this.deleteBatched('Notification', created(RETENTION.notificationDays), add)],
      ['sessions', 'Session', (add) => this.deleteBatched('Session', Prisma.sql`(t."expiresAt" < ${sessionCut} OR t."revokedAt" < ${sessionCut})`, add)],
      ['emailVerificationTokens', 'EmailVerificationToken', (add) => this.deleteBatched('EmailVerificationToken', usedOrExpired(RETENTION.tokenDays), add)],
      ['passwordResetTokens', 'PasswordResetToken', (add) => this.deleteBatched('PasswordResetToken', usedOrExpired(RETENTION.tokenDays), add)],
      ['telegramLinkTokens', 'TelegramLinkToken', (add) => this.deleteBatched('TelegramLinkToken', usedOrExpired(RETENTION.tokenDays), add)],
      ['analyses', 'ListingAnalysis', (add) => this.deleteAnalyses(before(RETENTION.analysisDays), add)],
    ];
    for (const [key, table, fn] of steps) {
      r[key] = 0;
      try {
        await fn((n) => (r[key] += n));
      } catch (err) {
        failed.push(table);
        this.logger.error(`Saklama temizliği "${table}" tablosunda başarısız: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const summary = Object.entries(r).map(([k, n]) => `${k}=${n}`).join(', ');
    this.logger.log(`Saklama temizliği: ${summary}${failed.length ? ` (hatalı: ${failed.join(', ')})` : ''}`);
    return r;
  }

  /** Her parti kısa bir transaction'da, kilit ve ifade zaman aşımıyla çalışır (tabloyu uzun süre kilitlemez). */
  private batchTx<T>(query: Prisma.PrismaPromise<T>): Promise<T> {
    return this.prisma
      .$transaction([
        this.prisma.$executeRaw`SET LOCAL lock_timeout = '5s'`,
        this.prisma.$executeRaw`SET LOCAL statement_timeout = '60s'`,
        query,
      ])
      .then((res) => res[2] as T);
  }

  /** `DELETE ... WHERE id IN (SELECT id ... LIMIT n)` döngüsü; bir parti n'den az silince biter. */
  private async deleteBatched(table: Table, where: Prisma.Sql, add: (n: number) => void): Promise<void> {
    const name = Prisma.raw(`"${table}"`);
    for (;;) {
      const n = await this.batchTx(
        this.prisma.$executeRaw(Prisma.sql`DELETE FROM ${name} WHERE id IN (SELECT t.id FROM ${name} t WHERE ${where} LIMIT ${RETENTION_BATCH})`),
      );
      add(n);
      if (n < RETENTION_BATCH) return;
    }
  }

  /**
   * Eski analizleri id sırasıyla ileri yürüyerek siler: her parti `id > lastId` olan en fazla 5000 eski adayı alır,
   * korunanları atlar ve lastId'yi görülen en büyük id'ye taşır (korunan satırlar her partide yeniden taranmaz).
   *
   * Korunanlar: Listing.latestAnalysisId; herhangi bir ListingMatch referansı; eşleştirme kuyruğuna hiç gönderilememiş
   * olay (sweep/admin yeniden gönderebilir); ilanın ilk analizi (bildirim planlayıcısı "ilk-görülme NEW" kararını
   * önceki analiz sayısından verir).
   *
   * ListingMatch.analysisId FK'si ON DELETE NO ACTION'dır: NOT EXISTS anlık görüntüsünden sonra eşzamanlı bir
   * eşleşme eklenirse DELETE FK hatasıyla reddedilir (cascade ile eşleşme silinmez); parti aynı lastId'den
   * yeniden denenir ve yeni eşleşme artık görüldüğü için o analiz korunur.
   */
  private async deleteAnalyses(cut: Date, add: (n: number) => void): Promise<void> {
    let lastId = 0;
    let fkRetries = 0;
    for (;;) {
      let row: { maxId: number | null; deleted: number };
      try {
        [row] = await this.batchTx(
          this.prisma.$queryRaw<{ maxId: number | null; deleted: number }[]>(Prisma.sql`
            WITH cand AS (
              SELECT t.id,
                (EXISTS (SELECT 1 FROM "Listing" l WHERE l."latestAnalysisId" = t.id)
                  OR EXISTS (SELECT 1 FROM "ListingMatch" m WHERE m."analysisId" = t.id)
                  OR (t."matchEvent" IS NOT NULL AND t."matchQueuedAt" IS NULL)
                  OR NOT EXISTS (SELECT 1 FROM "ListingAnalysis" p WHERE p."listingId" = t."listingId" AND p.id < t.id)) AS keep
              FROM "ListingAnalysis" t
              WHERE t.id > ${lastId} AND t."createdAt" < ${cut}
              ORDER BY t.id
              LIMIT ${RETENTION_BATCH}
            ), del AS (
              DELETE FROM "ListingAnalysis" a USING cand WHERE a.id = cand.id AND NOT cand.keep RETURNING a.id
            )
            SELECT (SELECT max(id) FROM cand) AS "maxId", (SELECT count(*) FROM del)::int AS deleted`),
        );
      } catch (err) {
        if (isForeignKeyViolation(err) && fkRetries < 3) {
          fkRetries += 1;
          this.logger.warn('Saklama: analiz silinirken eşzamanlı eşleşme eklendi (FK reddi); parti yeniden deneniyor');
          continue;
        }
        throw err;
      }
      if (row.maxId === null) return;
      add(row.deleted);
      lastId = row.maxId;
    }
  }
}

function isForeignKeyViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  return e?.meta?.code === '23503' || e?.code === 'P2003' || /23503|foreign key constraint/i.test(e?.message ?? '');
}
