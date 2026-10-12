import { Inject, Injectable } from '@nestjs/common';
import type { ProxyConfig } from '@oto/db';
import { Encryptor, guardedLookup, PRIVATE_ADDRESS_CODE, type HostLookup } from '@oto/server-common';
import { ErrorCode, type AdminProxyCreate, type AdminProxyUpdate } from '@oto/shared';
import { ProxyAgent, request } from 'undici';
import type { AuditCtx } from '../../common/audit/audit-ctx.decorator';
import { AuditService } from '../../common/audit/audit.service';
import { AppError, Errors } from '../../common/errors/app-error';
import { assertPublicHttpUrl } from '../../common/security/ssrf';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { PrismaService } from '../../infra/prisma.service';
import { boundLocks, LOCK_TX_OPTIONS } from '../../infra/tx-options';
import { RedisService } from '../../infra/redis.service';
import { ALLOW_PRIVATE_URLS } from './admin.tokens';
import { maskProxyUrl } from './url-mask';

export const PROXY_CHECK_TIMEOUT_MS = 10_000;
export const PROXY_CHECK_THROTTLE_SEC = 10;
export const proxyCheckKey = (id: number) => `proxy-check:${id}`;

/**
 * Proxy kontrolü için ProxyAgent seçenekleri. İç ağ yasaklıysa bağlantı anında (DNS rebinding'e karşı)
 * tüm çözülen adresler denetlenir; ön denetim (assertPublicHttpUrl) ayrıca yapılır.
 */
export function proxyAgentOptions(uri: string, allowPrivate: boolean, resolver?: HostLookup) {
  return {
    uri,
    // undici ProxyAgent proxy'ye bağlanırken yalnızca `proxyTls` ile kurulan bağlayıcıyı kullanır (`connect` etkisizdir).
    proxyTls: { timeout: PROXY_CHECK_TIMEOUT_MS, ...(allowPrivate ? {} : ({ lookup: guardedLookup(resolver) } as object)) },
    requestTls: { timeout: PROXY_CHECK_TIMEOUT_MS },
  };
}

@Injectable()
export class AdminProxiesService {
  private readonly checkUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly encryptor: Encryptor,
    private readonly redis: RedisService,
    @Inject(ENV) env: Env,
    @Inject(ALLOW_PRIVATE_URLS) private readonly allowPrivate: boolean,
  ) {
    this.checkUrl = env.PROXY_CHECK_URL;
  }

  private maskedUrl(p: ProxyConfig): string {
    try {
      return maskProxyUrl(this.encryptor.decrypt(p.urlEncrypted));
    } catch {
      return '[çözülemedi]';
    }
  }

  private view(p: ProxyConfig, sourceCount?: number) {
    return {
      id: p.id,
      name: p.name,
      url: this.maskedUrl(p),
      isEnabled: p.isEnabled,
      lastCheckAt: p.lastCheckAt,
      lastLatencyMs: p.lastLatencyMs,
      lastError: p.lastError,
      ...(sourceCount === undefined ? {} : { sourceCount }),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  async list() {
    const rows = await this.prisma.proxyConfig.findMany({ orderBy: { id: 'asc' }, include: { _count: { select: { sources: true } } } });
    return { total: rows.length, items: rows.map((p) => this.view(p, p._count.sources)) };
  }

  async create(ctx: AuditCtx, input: AdminProxyCreate) {
    await assertPublicHttpUrl(input.url, { allowPrivate: this.allowPrivate, allowCredentials: true });
    const created = await this.prisma.$transaction(async (tx) => {
      const p = await tx.proxyConfig.create({ data: { name: input.name, urlEncrypted: this.encryptor.encrypt(input.url), isEnabled: input.isEnabled } });
      await this.audit.recordInTx(tx, ctx, {
        targetType: 'ProxyConfig',
        targetId: String(p.id),
        before: null,
        after: { name: p.name, url: maskProxyUrl(input.url), isEnabled: p.isEnabled },
      });
      return p;
    });
    return { proxy: this.view(created) };
  }

  async update(ctx: AuditCtx, id: number, input: AdminProxyUpdate) {
    if (input.url !== undefined) await assertPublicHttpUrl(input.url, { allowPrivate: this.allowPrivate, allowCredentials: true });
    return this.prisma.$transaction(async (tx) => {
      await boundLocks(tx);
      const [locked] = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM "ProxyConfig" WHERE id = ${id} FOR NO KEY UPDATE`;
      if (!locked) throw Errors.notFound();
      const before = await tx.proxyConfig.findUniqueOrThrow({ where: { id } });
      const beforeUrl = this.encryptor.decrypt(before.urlEncrypted);
      const data: { name?: string; isEnabled?: boolean; urlEncrypted?: string } = {};
      if (input.name !== undefined && input.name !== before.name) data.name = input.name;
      if (input.isEnabled !== undefined && input.isEnabled !== before.isEnabled) data.isEnabled = input.isEnabled;
      if (input.url !== undefined && input.url !== beforeUrl) data.urlEncrypted = this.encryptor.encrypt(input.url);
      if (Object.keys(data).length === 0) return { proxy: this.view(before) };
      const after = await tx.proxyConfig.update({ where: { id }, data: { ...data, ...(data.urlEncrypted ? { lastCheckAt: null, lastLatencyMs: null, lastError: null } : {}) } });
      await this.audit.recordInTx(tx, ctx, {
        targetType: 'ProxyConfig',
        targetId: String(id),
        before: { name: before.name, url: maskProxyUrl(beforeUrl), isEnabled: before.isEnabled },
        after: { name: after.name, url: maskProxyUrl(input.url ?? beforeUrl), isEnabled: after.isEnabled },
      });
      return { proxy: this.view(after) };
    }, LOCK_TX_OPTIONS);
  }

  /** Proxy üzerinden yapılandırılmış hedefe istek atar; sonucu (gecikme/hata) kaydeder. */
  async check(ctx: AuditCtx, id: number) {
    const proxy = await this.prisma.proxyConfig.findUnique({ where: { id } });
    if (!proxy) throw Errors.notFound();
    const url = this.encryptor.decrypt(proxy.urlEncrypted);
    const acquired = await this.redis.set(proxyCheckKey(id), '1', 'EX', PROXY_CHECK_THROTTLE_SEC, 'NX').catch(() => {
      throw new AppError(ErrorCode.INTERNAL, 503, 'Proxy kontrolü şu anda yapılamıyor');
    });
    if (acquired !== 'OK') throw new AppError(ErrorCode.RATE_LIMITED, 429, `Proxy kontrolü ${PROXY_CHECK_THROTTLE_SEC} saniyede en fazla 1 kez yapılabilir`);
    let latencyMs: number | null = null;
    let error: string | null = null;
    const startedAt = Date.now();
    let agent: ProxyAgent | null = null;
    try {
      await assertPublicHttpUrl(url, { allowPrivate: this.allowPrivate, allowCredentials: true });
      agent = new ProxyAgent(proxyAgentOptions(url, this.allowPrivate));
      const res = await request(this.checkUrl, {
        dispatcher: agent,
        method: 'GET',
        signal: AbortSignal.timeout(PROXY_CHECK_TIMEOUT_MS),
        headersTimeout: PROXY_CHECK_TIMEOUT_MS,
        bodyTimeout: PROXY_CHECK_TIMEOUT_MS,
      });
      await res.body.dump().catch(() => undefined);
      latencyMs = Date.now() - startedAt;
      if (res.statusCode >= 400) error = `HTTP ${res.statusCode}`;
    } catch (err) {
      latencyMs = null;
      error = this.describeError(err, url);
    } finally {
      await agent?.close().catch(() => undefined);
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      // Kontrol sırasında URL değiştiyse (eski URL'nin sonucu) yazılmaz.
      const { count } = await tx.proxyConfig.updateMany({
        where: { id, urlEncrypted: proxy.urlEncrypted },
        data: { lastCheckAt: new Date(), lastLatencyMs: error ? null : latencyMs, lastError: error },
      });
      const p = await tx.proxyConfig.findUnique({ where: { id } });
      if (!p) throw Errors.notFound();
      if (count === 0) return p;
      await this.audit.recordInTx(tx, ctx, { targetType: 'ProxyConfig', targetId: String(id), before: null, after: { ok: !error, latencyMs: error ? null : latencyMs, error } });
      return p;
    });
    return { proxy: this.view(updated) };
  }

  /** Hata metninden proxy kimlik bilgisini ve URL sorgularını ayıklar. */
  private describeError(err: unknown, proxyUrl: string): string {
    const name = err instanceof Error ? err.name : 'Error';
    if (name === 'TimeoutError' || name === 'AbortError') return `Zaman aşımı (${PROXY_CHECK_TIMEOUT_MS / 1000} sn)`;
    const e = err as { code?: string; cause?: { code?: string }; message?: string };
    const code = e.code ?? e.cause?.code;
    if (code === PRIVATE_ADDRESS_CODE) return 'Proxy özel/iç ağ adresine çözümleniyor';
    let msg = String(e.message ?? err);
    try {
      const u = new URL(proxyUrl);
      for (const secret of [u.username, u.password, decodeURIComponent(u.username), decodeURIComponent(u.password)]) {
        if (secret) msg = msg.split(secret).join('***');
      }
    } catch {
      /* geçersiz URL: ayıklanacak bir şey yok */
    }
    return (code ? `${code}: ${msg}` : msg).slice(0, 300);
  }
}
