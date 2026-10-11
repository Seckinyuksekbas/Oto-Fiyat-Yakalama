import { Injectable } from '@nestjs/common';
import type { Notification } from '@oto/db';
import { userEventChannel, type UserEvent } from '@oto/shared';
import { RedisService } from '../infra/redis.service';
import type { SendResult } from './notify.service';

@Injectable()
export class InAppAdapter {
  constructor(private readonly redis: RedisService) {}

  /** Kayıt zaten DB'de; "gönderim" = canlı panellere yayın. Çevrimdışı kullanıcı kaydı sonradan görür. */
  async send(n: Notification): Promise<SendResult> {
    const event: UserEvent = {
      type: 'notification',
      notification: { id: n.id, kind: n.kind, channel: 'IN_APP', status: 'SENT', payload: n.payload, createdAt: n.createdAt.toISOString() },
    };
    try {
      await this.redis.publish(userEventChannel(n.userId), JSON.stringify(event));
      return { kind: 'SENT' };
    } catch (err) {
      return { kind: 'RETRYABLE', error: err instanceof Error ? err.message : String(err) };
    }
  }
}
