import { Controller, type MessageEvent, Sse } from '@nestjs/common';
import type { Role } from '@oto/db';
import { interval, merge, Observable, takeUntil, timer } from 'rxjs';
import { CurrentUser } from '../../common/decorators/current-user';
import { Roles } from '../../common/decorators/roles';
import { ShutdownSignal } from '../../infra/shutdown-signal.service';
import { StreamSessionService } from '../../infra/stream-session.service';
import type { AuthUser } from '../auth/auth-user';
import { SSE_MAX_LIFETIME_MS, SSE_PING_MS } from '../me/notifications.controller';
import { AdminEventsService } from './admin-events.service';
import { AdminOverviewService } from './overview.service';

const ADMIN_ROLES: readonly Role[] = ['ADMIN', 'SUPER_ADMIN'];

@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin')
export class AdminStreamController {
  constructor(
    private readonly events: AdminEventsService,
    private readonly overview: AdminOverviewService,
    private readonly session: StreamSessionService,
    private readonly shutdown: ShutdownSignal,
  ) {}

  /**
   * Admin canlı akışı: `ready` (genel bakış), `alert`, `job` (Redis `admin:events`), `kpi` (30 sn; paylaşılan önbellekten),
   * `ping`; 15 dk ömür. Her KPI tick'inde oturum + rol (ADMIN/SUPER_ADMIN) + ACTIVE yeniden doğrulanır; geçersizse akış biter.
   * Kullanıcı akışıyla aynı desen: canlı olaylara önce abone olunur, `ready` gönderilene kadar tamponlanır; bağlantı
   * kapanınca dinleyici ve zamanlayıcılar bırakılır (Redis aboneliği uygulama başına tektir).
   */
  @Sse('stream')
  stream(@CurrentUser() user: AuthUser): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const buffer: MessageEvent[] = [];
      let isReady = false;
      const live = this.events.stream().subscribe((e) => {
        const m = { type: e.type, data: e } as MessageEvent;
        if (isReady) subscriber.next(m);
        else buffer.push(m);
      });
      const ping = interval(SSE_PING_MS).subscribe(() => subscriber.next({ type: 'ping', data: {} } as MessageEvent));
      let tickBusy = false;
      const tick = interval(this.session.recheckMs).subscribe(() => {
        if (tickBusy || !isReady) return;
        tickBusy = true;
        void (async () => {
          if (!(await this.session.isValid(user, ADMIN_ROLES))) {
            subscriber.complete();
            return;
          }
          const data = await this.overview.cachedKpi();
          if (!subscriber.closed) subscriber.next({ type: 'kpi', data } as MessageEvent);
        })()
          .catch(() => undefined)
          .finally(() => {
            tickBusy = false;
          });
      });
      void (async () => {
        await this.events.subscribed();
        const snapshot = await this.overview.overview();
        if (subscriber.closed) return;
        subscriber.next({ type: 'ready', data: snapshot } as MessageEvent);
        isReady = true;
        for (const m of buffer.splice(0)) subscriber.next(m);
      })().catch((err: unknown) => subscriber.error(err));
      return () => {
        live.unsubscribe();
        ping.unsubscribe();
        tick.unsubscribe();
      };
    }).pipe(takeUntil(merge(timer(SSE_MAX_LIFETIME_MS), this.shutdown.signal$)));
  }
}
