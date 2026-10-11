import { Controller, type MessageEvent, Sse } from '@nestjs/common';
import { interval, Observable, takeUntil, timer } from 'rxjs';
import { Roles } from '../../common/decorators/roles';
import { SSE_MAX_LIFETIME_MS, SSE_PING_MS } from '../me/notifications.controller';
import { AdminEventsService } from './admin-events.service';
import { AdminOverviewService } from './overview.service';

/** Sunucu tarafında hesaplanan KPI özeti bu aralıkla gönderilir. */
export const ADMIN_KPI_INTERVAL_MS = 30_000;

@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin')
export class AdminStreamController {
  constructor(
    private readonly events: AdminEventsService,
    private readonly overview: AdminOverviewService,
  ) {}

  /**
   * Admin canlı akışı: `ready` (genel bakış), `alert`, `job` (Redis `admin:events`), 30 sn'de bir `kpi`, `ping`; 15 dk ömür.
   * Kullanıcı akışıyla aynı desen: canlı olaylara önce abone olunur, `ready` gönderilene kadar tamponlanır; bağlantı
   * kapanınca dinleyici ve zamanlayıcılar bırakılır (Redis aboneliği uygulama başına tektir).
   */
  @Sse('stream')
  stream(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const buffer: MessageEvent[] = [];
      let isReady = false;
      const live = this.events.stream().subscribe((e) => {
        const m = { type: e.type, data: e } as MessageEvent;
        if (isReady) subscriber.next(m);
        else buffer.push(m);
      });
      const ping = interval(SSE_PING_MS).subscribe(() => subscriber.next({ type: 'ping', data: {} } as MessageEvent));
      let kpiBusy = false;
      const kpi = interval(ADMIN_KPI_INTERVAL_MS).subscribe(() => {
        if (kpiBusy || !isReady) return;
        kpiBusy = true;
        this.overview
          .kpi()
          .then((data) => {
            if (!subscriber.closed) subscriber.next({ type: 'kpi', data } as MessageEvent);
          })
          .catch(() => undefined)
          .finally(() => {
            kpiBusy = false;
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
        kpi.unsubscribe();
      };
    }).pipe(takeUntil(timer(SSE_MAX_LIFETIME_MS)));
  }
}
