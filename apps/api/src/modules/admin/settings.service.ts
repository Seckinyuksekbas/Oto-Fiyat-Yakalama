import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@oto/db';
import {
  alertThresholdsSchema,
  analysisSettingsSchema,
  DEFAULT_ALERT_THRESHOLDS,
  DEFAULT_ANALYSIS_SETTINGS,
  parseSettingValue,
  SETTINGS_CHANGED_CHANNEL,
  settingKeySchema,
  type SettingKey,
} from '@oto/shared';
import type { AuditCtx } from '../../common/audit/audit-ctx.decorator';
import { AuditService } from '../../common/audit/audit.service';
import { Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../infra/prisma.service';
import { RedisService } from '../../infra/redis.service';

/** Worker'lar (AnalysisSettingsService vb.) bu kanala abonedir; mesaj = değişen anahtar. */
export { SETTINGS_CHANGED_CHANNEL };

export interface AdminSettingView {
  key: SettingKey;
  /** Kayıtlı geçersiz kılma (kısmi); kayıt yoksa null */
  value: Record<string, unknown> | null;
  updatedAt: Date | null;
  defaults: Record<string, unknown>;
  /** Varsayılanlar + kayıtlı değer: worker'ların fiilen kullandığı değer */
  effective: Record<string, unknown>;
}

const DEFAULTS: Record<SettingKey, Record<string, unknown>> = {
  'analysis.settings': DEFAULT_ANALYSIS_SETTINGS,
  'alerts.thresholds': DEFAULT_ALERT_THRESHOLDS,
};

const SHAPES: Record<SettingKey, Record<string, unknown>> = {
  'analysis.settings': analysisSettingsSchema.shape,
  'alerts.thresholds': alertThresholdsSchema.shape,
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(norm) : isPlainObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])])) : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

function effectiveOf(key: SettingKey, value: unknown): Record<string, unknown> {
  const schema = key === 'analysis.settings' ? analysisSettingsSchema : alertThresholdsSchema;
  const r = schema.safeParse(value ?? {});
  return r.success ? r.data : DEFAULTS[key];
}

@Injectable()
export class AdminSettingsService {
  private readonly logger = new Logger(AdminSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  private view(key: SettingKey, row: { value: Prisma.JsonValue; updatedAt: Date } | null): AdminSettingView {
    const value = row && isPlainObject(row.value) ? row.value : null;
    return { key, value, updatedAt: row?.updatedAt ?? null, defaults: DEFAULTS[key], effective: effectiveOf(key, value) };
  }

  async list(): Promise<{ items: AdminSettingView[] }> {
    const keys = settingKeySchema.options;
    const rows = await this.prisma.systemSetting.findMany({ where: { key: { in: [...keys] } } });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return { items: keys.map((k) => this.view(k, byKey.get(k) ?? null)) };
  }

  /**
   * JSON merge patch (RFC 7396, tek seviye): `value` alanları kayıtlı değerin üzerine yazılır, `null` alan varsayılana döner.
   * Doğrulama BİRLEŞMİŞ değer üzerinde çalışır (tip, bilinmeyen alan, aralık, çapraz alan kuralları); hata → 400, kayıt değişmez.
   * Değişiklik yoksa yazma/denetim/yayın yapılmaz. Yayın commit'ten sonra; başarısızlığı isteği bozmaz (worker 60 sn TTL'i yedektir).
   */
  async update(ctx: AuditCtx, key: SettingKey, patch: unknown): Promise<{ setting: AdminSettingView }> {
    if (!isPlainObject(patch)) throw Errors.validation([{ path: 'value', message: 'value bir nesne olmalı' }]);
    // Yalnızca şemadaki alanlar: `__proto__`/`constructor` gibi anahtarlar birleştirmeye hiç girmez.
    const allowed = new Set(Object.keys(SHAPES[key]));
    const unknown = Object.keys(patch).filter((k) => !allowed.has(k));
    if (unknown.length > 0) throw Errors.validation(unknown.map((k) => ({ path: `value.${k}`, message: 'Bilinmeyen alan' })));
    const out = await this.prisma.$transaction(async (tx) => {
      // Okuma-birleştirme-yazma yarışını (eşzamanlı iki PATCH) anahtar başına danışma kilidiyle sıralar.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`system-setting:${key}`}))`;
      const row = await tx.systemSetting.findUnique({ where: { key } });
      // Kayıtlı değer geçersizse sessizce atılmaz: yama ham kayıt üzerine uygulanır, birleşim doğrulanır (hata → 400);
      // yönetici bozuk alanları `null` göndererek düzeltebilir. Bilinmeyen kayıtlı alanlar düşürülür.
      const merged = new Map<string, unknown>();
      if (row && isPlainObject(row.value)) {
        for (const [k, v] of Object.entries(row.value)) if (allowed.has(k)) merged.set(k, v);
      }
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) merged.delete(k);
        else merged.set(k, v);
      }
      const parsed = parseSettingValue(key, Object.fromEntries(merged));
      if (!parsed.ok) throw Errors.validation(parsed.issues.map((i) => ({ path: ['value', ...i.path].join('.'), message: i.message })));
      const next = parsed.value as Record<string, unknown>;
      if (row ? sameJson(row.value, next) : Object.keys(next).length === 0) return { row, changed: false };
      const saved = await tx.systemSetting.upsert({
        where: { key },
        create: { key, value: next as Prisma.InputJsonValue },
        update: { value: next as Prisma.InputJsonValue },
      });
      await this.audit.recordInTx(tx, ctx, { targetType: 'SystemSetting', targetId: key, before: row?.value ?? undefined, after: next });
      return { row: saved, changed: true };
    });
    if (out.changed) {
      await this.redis.publish(SETTINGS_CHANGED_CHANNEL, key).catch((err: unknown) => {
        this.logger.warn(`${SETTINGS_CHANGED_CHANNEL} yayını başarısız (${key}); worker'lar TTL ile güncellenecek: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return { setting: this.view(key, out.row) };
  }
}
