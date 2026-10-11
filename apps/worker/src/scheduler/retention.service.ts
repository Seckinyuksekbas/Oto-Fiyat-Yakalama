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

  /** Günlük temizlik. Tablo başına silinen satır sayısını döner. Tablolar sırayla (paralel değil) işlenir. */
  async run(now: Date = new Date()): Promise<RetentionResult> {
    const before = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const created = (days: number) => Prisma.sql`t."createdAt" < ${before(days)}`;
    const usedOrExpired = (days: number) => Prisma.sql`(t."usedAt" < ${before(days)} OR t."expiresAt" < ${before(days)})`;
    const r = {} as RetentionResult;

    r.systemLogs = await this.deleteBatched('SystemLog', created(RETENTION.systemLogDays));
    r.scrapeErrors = await this.deleteBatched('ScrapeError', created(RETENTION.scrapeErrorDays));
    r.listingIssues = await this.deleteBatched('ListingIssue', created(RETENTION.listingIssueDays));
    r.auditLogs = await this.deleteBatched('AuditLog', created(RETENTION.auditLogDays));
    // Notification → ListingMatch FK'si bildirimden eşleşmeye doğrudur: bildirim silmek eşleşmeye dokunmaz.
    r.notifications = await this.deleteBatched('Notification', created(RETENTION.notificationDays));
    const sessionCut = before(RETENTION.sessionDays);
    r.sessions = await this.deleteBatched('Session', Prisma.sql`(t."expiresAt" < ${sessionCut} OR t."revokedAt" < ${sessionCut})`);
    r.emailVerificationTokens = await this.deleteBatched('EmailVerificationToken', usedOrExpired(RETENTION.tokenDays));
    r.passwordResetTokens = await this.deleteBatched('PasswordResetToken', usedOrExpired(RETENTION.tokenDays));
    r.telegramLinkTokens = await this.deleteBatched('TelegramLinkToken', usedOrExpired(RETENTION.tokenDays));
    // ListingMatch.analysisId ON DELETE CASCADE: eşleşmesi olan analiz silinirse eşleşme (ve bildirimleri) de silinir,
    // dedup anahtarı kaybolur ve NEW yeniden tetiklenebilir. Bu yüzden referanslı analizler ASLA silinmez.
    // Ek korumalar: eşleştirme kuyruğuna hiç gönderilememiş olay (sweep/admin yeniden gönderebilir) ve ilanın
    // ilk analizi (bildirim planlayıcısı "ilk-görülme NEW" kararını önceki analiz sayısından verir) kalır.
    r.analyses = await this.deleteBatched(
      'ListingAnalysis',
      Prisma.sql`${created(RETENTION.analysisDays)}
        AND NOT EXISTS (SELECT 1 FROM "Listing" l WHERE l."latestAnalysisId" = t.id)
        AND NOT EXISTS (SELECT 1 FROM "ListingMatch" m WHERE m."analysisId" = t.id)
        AND (t."matchEvent" IS NULL OR t."matchQueuedAt" IS NOT NULL)
        AND EXISTS (SELECT 1 FROM "ListingAnalysis" p WHERE p."listingId" = t."listingId" AND p.id < t.id)`,
    );

    this.logger.log(`Saklama temizliği: ${Object.entries(r).map(([k, n]) => `${k}=${n}`).join(', ')}`);
    return r;
  }

  /** `DELETE ... WHERE id IN (SELECT id ... LIMIT n)` döngüsü; bir parti n'den az silince biter. */
  private async deleteBatched(table: Table, where: Prisma.Sql): Promise<number> {
    const name = Prisma.raw(`"${table}"`);
    let total = 0;
    for (;;) {
      const n = await this.prisma.$executeRaw(
        Prisma.sql`DELETE FROM ${name} WHERE id IN (SELECT t.id FROM ${name} t WHERE ${where} LIMIT ${RETENTION_BATCH})`,
      );
      total += n;
      if (n < RETENTION_BATCH) return total;
    }
  }
}
