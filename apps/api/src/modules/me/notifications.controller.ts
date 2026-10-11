import { Body, Controller, Get, HttpCode, type MessageEvent, Post, Query, Sse } from '@nestjs/common';
import {
  listNotificationsQuerySchema,
  markNotificationsReadSchema,
  type ListNotificationsQuery,
  type MarkNotificationsReadInput,
} from '@oto/shared';
import { interval, Observable, takeUntil, timer } from 'rxjs';
import { CurrentUser } from '../../common/decorators/current-user';
import { ZodPipe } from '../../common/zod.pipe';
import { StreamSessionService } from '../../infra/stream-session.service';
import { UserEventsService } from '../../infra/user-events.service';
import type { AuthUser } from '../auth/auth-user';
import { NotificationsRepository } from './notifications.repository';

export interface NotificationView {
  id: number;
  kind: string;
  channel: string;
  status: string;
  attempts: number;
  lastError: string | null;
  payload: unknown;
  sentAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
}

export const SSE_PING_MS = 25_000;
export const SSE_MAX_LIFETIME_MS = 15 * 60_000;

@Controller('me/notifications')
export class NotificationsController {
  constructor(
    private readonly repo: NotificationsRepository,
    private readonly events: UserEventsService,
    private readonly session: StreamSessionService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodPipe(listNotificationsQuerySchema)) q: ListNotificationsQuery,
  ): Promise<{ items: NotificationView[]; nextCursor: number | null; unreadCount: number }> {
    const [rows, unreadCount] = await Promise.all([this.repo.list(user.id, q), this.repo.unreadCount(user.id)]);
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((n) => ({
        id: n.id,
        kind: n.kind,
        channel: n.channel,
        status: n.status,
        attempts: n.attempts,
        lastError: n.lastError,
        payload: n.payload,
        sentAt: n.sentAt,
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
      nextCursor: rows.length > q.limit ? page[page.length - 1].id : null,
      unreadCount,
    };
  }

  @Post('read')
  @HttpCode(200)
  async read(@CurrentUser() user: AuthUser, @Body(new ZodPipe(markNotificationsReadSchema)) body: MarkNotificationsReadInput) {
    return { updated: await this.repo.markRead(user.id, body) };
  }

  @Sse('stream')
  stream(@CurrentUser() user: AuthUser): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      // Canlı olaylara önce abone olunur; "ready" gönderilene kadar tamponlanır (başlangıç boşluğu olmasın).
      const buffer: MessageEvent[] = [];
      let isReady = false;
      const live = this.events.stream(user.id).subscribe((e) => {
        const m = { type: 'notification', data: e.notification } as MessageEvent;
        if (isReady) subscriber.next(m);
        else buffer.push(m);
      });
      const ping = interval(SSE_PING_MS).subscribe(() => subscriber.next({ type: 'ping', data: {} } as MessageEvent));
      // Oturum iptal edildiyse / kullanıcı askıya alındıysa akış 15 dk ömrünü beklemeden kapanır.
      const recheck = interval(this.session.recheckMs).subscribe(() => {
        this.session
          .isValid(user)
          .then((ok) => {
            if (!ok) subscriber.complete();
          })
          .catch(() => undefined);
      });
      void (async () => {
        await this.events.subscribed();
        const snapshot = await this.repo.readySnapshot(user.id);
        if (subscriber.closed) return;
        subscriber.next({ type: 'ready', data: snapshot } as MessageEvent);
        isReady = true;
        for (const m of buffer.splice(0)) subscriber.next(m);
      })().catch((err: unknown) => subscriber.error(err));
      return () => {
        live.unsubscribe();
        ping.unsubscribe();
        recheck.unsubscribe();
      };
    }).pipe(takeUntil(timer(SSE_MAX_LIFETIME_MS)));
  }
}
