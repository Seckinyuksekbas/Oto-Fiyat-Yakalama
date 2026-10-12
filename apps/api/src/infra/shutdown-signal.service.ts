import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Observable, ReplaySubject } from 'rxjs';

/**
 * Uygulama kapanışı sinyali. Nest kapanış sırası: onModuleDestroy → beforeApplicationShutdown → HTTP sunucusu kapanır
 * (forceCloseConnections) → onApplicationShutdown. Sinyal ilk aşamada (onModuleDestroy) yayılır; uzun ömürlü SSE akışları
 * `takeUntil(shutdown.signal$)` ile düzgün tamamlanır. Redis abonelikleri, Redis ve Prisma `onApplicationShutdown`'da,
 * yani akışlar bittikten ve HTTP sunucusu kapandıktan SONRA kapatılır.
 */
@Injectable()
export class ShutdownSignal implements OnModuleDestroy {
  private readonly subject = new ReplaySubject<void>(1);
  private fired = false;

  /** Kapanışta bir kez yayar ve tamamlanır; sonradan abone olan da hemen alır. */
  readonly signal$: Observable<void> = this.subject.asObservable();

  get isShuttingDown(): boolean {
    return this.fired;
  }

  /** İdempotent. */
  trigger(): void {
    if (this.fired) return;
    this.fired = true;
    this.subject.next();
    this.subject.complete();
  }

  onModuleDestroy(): void {
    this.trigger();
  }
}
