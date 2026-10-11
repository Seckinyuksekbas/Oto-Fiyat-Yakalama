import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@oto/shared';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { RedisService } from '../../infra/redis.service';

/**
 * Worker süreçleri (apps/worker HeartbeatService) iki anahtar yazar: `worker:heartbeat:<host>:<pid>` (TTL 45 sn → canlı)
 * ve `worker:seen:<host>:<pid>` (aynı JSON, TTL 24 saat). Heartbeat'i bitmiş ama seen kaydı duran worker ölü listelenir.
 */
const HEARTBEAT_PREFIX = 'worker:heartbeat:';
const SEEN_PREFIX = 'worker:seen:';
/** Taranacak en fazla anahtar (her önek için); beklenmedik anahtar patlamasında yanıt sınırlı kalır. */
const MAX_KEYS = 1000;

const beatSchema = z.object({
  host: z.string().max(255),
  pid: z.number().int(),
  role: z.string().max(50),
  startedAt: z.string().max(40),
  at: z.string().max(40),
});
type Beat = z.infer<typeof beatSchema>;

export interface AdminWorker {
  host: string;
  pid: number;
  role: string;
  startedAt: string;
  lastSeenAt: string;
  alive: boolean;
}

@Injectable()
export class AdminWorkersService {
  constructor(private readonly redis: RedisService) {}

  async list(): Promise<AdminWorker[]> {
    let beats: Map<string, Beat>;
    let seen: Map<string, Beat>;
    try {
      [beats, seen] = await Promise.all([this.read(HEARTBEAT_PREFIX), this.read(SEEN_PREFIX)]);
    } catch {
      throw new AppError(ErrorCode.INTERNAL, 503, 'Worker durumu şu anda okunamıyor');
    }
    const out: AdminWorker[] = [];
    for (const b of beats.values()) out.push(toWorker(b, true));
    for (const [id, b] of seen) if (!beats.has(id)) out.push(toWorker(b, false));
    return out.sort((a, b) => Number(b.alive) - Number(a.alive) || a.host.localeCompare(b.host) || a.pid - b.pid);
  }

  /** `<önek><host>:<pid>` anahtarlarını SCAN ile bulur, değerleri doğrular; bozuk değerler atlanır. Anahtar: `<host>:<pid>`. */
  private async read(prefix: string): Promise<Map<string, Beat>> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0' && keys.length < MAX_KEYS);
    const unique = [...new Set(keys)].slice(0, MAX_KEYS);
    const result = new Map<string, Beat>();
    if (unique.length === 0) return result;
    const values = await this.redis.mget(...unique);
    unique.forEach((key, i) => {
      const parsed = parse(values[i]);
      if (parsed) result.set(key.slice(prefix.length), parsed);
    });
    return result;
  }
}

function parse(raw: string | null): Beat | null {
  if (!raw) return null;
  try {
    const r = beatSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

const toWorker = (b: Beat, alive: boolean): AdminWorker => ({ host: b.host, pid: b.pid, role: b.role, startedAt: b.startedAt, lastSeenAt: b.at, alive });
