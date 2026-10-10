import { Body, Controller, Get, HttpCode, type MessageEvent, Post, Query, Sse } from '@nestjs/common';
import {
  listNotificationsQuerySchema,
  markNotificationsReadSchema,
  type ListNotificationsQuery,
  type MarkNotificationsReadInput,
} from '@oto/shared';
import { concat, defer, from, interval, map, merge, takeUntil, timer, type Observable } from 'rxjs';
import { CurrentUser } from '../../common/decorators/current-user';
import { ZodPipe } from '../../common/zod.pipe';
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
    const ready$ = defer(() => from(this.repo.unreadCount(user.id))).pipe(
      map((unreadCount) => ({ type: 'ready', data: { unreadCount } }) as MessageEvent),
    );
    const live$ = this.events.stream(user.id).pipe(map((e) => ({ type: 'notification', data: e.notification }) as MessageEvent));
    const ping$ = interval(SSE_PING_MS).pipe(map(() => ({ type: 'ping', data: {} }) as MessageEvent));
    return concat(ready$, merge(live$, ping$)).pipe(takeUntil(timer(SSE_MAX_LIFETIME_MS)));
  }
}
