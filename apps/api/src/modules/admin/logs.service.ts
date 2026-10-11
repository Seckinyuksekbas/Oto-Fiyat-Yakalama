import { Injectable } from '@nestjs/common';
import type { Prisma } from '@oto/db';
import { adminAuditLogsQuerySchema, adminSystemLogsQuerySchema, escapeLike } from '@oto/shared';
import { z } from 'zod';
import { PrismaService } from '../../infra/prisma.service';
import { maskUrlsInText } from './url-mask';

const page = {
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};
const text = (max: number) => z.string().trim().min(1).max(max);
const orderedRange = (q: { from?: string; to?: string }, ctx: z.RefinementCtx) => {
  if (q.from && q.to && new Date(q.from) > new Date(q.to)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'to, from değerinden önce olamaz' });
};

/** Paylaşılan şema + `actor` (e-posta, kısmi), `targetId`; `action` kısmi eşleşme. */
export const auditLogsQuery = adminAuditLogsQuerySchema
  .extend({ actor: text(100).optional(), targetId: text(100).optional(), ...page })
  .strict()
  .superRefine(orderedRange);
export type AuditLogsQuery = z.infer<typeof auditLogsQuery>;

/** Paylaşılan şema + `q` (mesajda kısmi arama). `component` tam eşleşme. */
export const systemLogsQuery = adminSystemLogsQuerySchema
  .extend({ q: text(200).optional(), ...page })
  .strict()
  .superRefine(orderedRange);
export type SystemLogsQuery = z.infer<typeof systemLogsQuery>;

/** Gizli görünümlü anahtarlar (geniş tutulur: `passengerCount`, `author` gibi fazladan maskeleme kabul edilebilir). */
const SECRET_KEY = /(token|secret|pass(wd|word)?|auth|cookie|chat_?id|^key$|api[-_]?key|private|signature|dsn|credential|encrypted|session)/i;
const MAX_DEPTH = 8;

/** SystemLog.context için: gizli görünümlü anahtarları `[gizli]` yapar, metinlerdeki URL sorgularını maskeler. */
export function sanitizeLogContext(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return maskUrlsInText(value);
  if (typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[derin]';
  if (Array.isArray(value)) return value.map((v) => sanitizeLogContext(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[gizli]' : sanitizeLogContext(v, depth + 1)]),
  );
}

const dateRange = (q: { from?: string; to?: string }) =>
  q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {};

export interface AuditLogItem {
  id: number;
  action: string;
  actor: { id: string; email: string; name: string; role: string; status: string } | null;
  targetType: string | null;
  targetId: string | null;
  before: Prisma.JsonValue;
  after: Prisma.JsonValue;
  ip: string | null;
  createdAt: Date;
}

export interface SystemLogItem {
  id: number;
  level: string;
  component: string;
  message: string;
  context: unknown;
  createdAt: Date;
}

@Injectable()
export class AdminLogsService {
  constructor(private readonly prisma: PrismaService) {}

  /** before/after kaydedildiği gibi döner (silinen kullanıcılar için anonimleştirmede zaten `{redacted:true}`). */
  async auditLogs(q: AuditLogsQuery): Promise<{ total: number; items: AuditLogItem[] }> {
    const where: Prisma.AuditLogWhereInput = {
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.actor ? { actor: { email: { contains: escapeLike(q.actor), mode: 'insensitive' } } } : {}),
      ...(q.action ? { action: { contains: escapeLike(q.action), mode: 'insensitive' } } : {}),
      ...(q.targetType ? { targetType: q.targetType } : {}),
      ...(q.targetId ? { targetId: q.targetId } : {}),
      ...dateRange(q),
    };
    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { actor: { select: { id: true, email: true, name: true, role: true, status: true } } },
      }),
    ]);
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        action: r.action,
        actor: r.actor,
        targetType: r.targetType,
        targetId: r.targetId,
        before: r.before,
        after: r.after,
        ip: r.ip,
        createdAt: r.createdAt,
      })),
    };
  }

  async systemLogs(q: SystemLogsQuery): Promise<{ total: number; items: SystemLogItem[] }> {
    const where: Prisma.SystemLogWhereInput = {
      ...(q.level ? { level: q.level } : {}),
      ...(q.component ? { component: q.component } : {}),
      ...(q.q ? { message: { contains: escapeLike(q.q), mode: 'insensitive' } } : {}),
      ...dateRange(q),
    };
    const [total, rows] = await Promise.all([
      this.prisma.systemLog.count({ where }),
      this.prisma.systemLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        level: r.level,
        component: r.component,
        message: maskUrlsInText(r.message),
        context: sanitizeLogContext(r.context),
        createdAt: r.createdAt,
      })),
    };
  }
}
