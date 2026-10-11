/** Kapatılabilir kuyruk worker'ı (BullMQ `Worker` ile uyumlu, testte sahte nesne verilebilir). */
export interface ClosableWorker {
  close(force?: boolean): Promise<void>;
  /** Varsa zarif bekleme bununla yapılır: yeni iş almaz, aktif işlerin bitmesini bekler. */
  pause?(doNotWaitActive?: boolean): Promise<void>;
}

export interface CloseLogger {
  warn(message: string): void;
  error(message: string): void;
}

type Outcome = { kind: 'done' } | { kind: 'failed'; error: unknown } | { kind: 'timeout' };

function within(promise: Promise<void>, ms: number): Promise<Outcome> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), ms);
  });
  const settled = promise.then(
    (): Outcome => ({ kind: 'done' }),
    (error: unknown): Outcome => ({ kind: 'failed', error }),
  );
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
}

/** Zorla kapatma için üst sınır: kapanışın toplamı SHUTDOWN_TIMEOUT_MS (en fazla 40 sn) + 5 sn ≤ compose stop_grace_period 45 sn. */
export const FORCE_CLOSE_BOUND_MS = 5000;

const describeError = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Sınırlı graceful shutdown: aktif işler `ms` içinde biterse worker zarifçe kapanır; aksi halde `close(true)` ile zorla
 * kapatılır (aktif işlerin kilidi yenilenmez, BullMQ onları stalled olarak başka worker'a yeniden verir).
 *
 * BullMQ `close()` çağrısı önbelleğe alınır: `close()` beklerken çağrılan `close(true)` aynı bekleyen sözü döndürür ve
 * zorlamaz. Bu yüzden aktif işler önce `pause()` ile beklenir; `close()` yalnız iş kalmadığında çağrılır ve süre
 * aşımında ilk kapatma çağrısı `close(true)` olur. Zorla kapatma da `min(ms, FORCE_CLOSE_BOUND_MS)` ile sınırlanır.
 */
export async function closeWithTimeout(worker: ClosableWorker, ms: number, logger: CloseLogger): Promise<'graceful' | 'forced'> {
  const graceful = (async () => {
    if (worker.pause) await worker.pause();
    await worker.close();
  })();
  const first = await within(graceful, ms);
  if (first.kind === 'done') return 'graceful';

  if (first.kind === 'timeout') logger.warn(`Aktif işler ${ms} ms içinde bitmedi; worker zorla kapatılıyor (işler stalled olarak yeniden işlenecek)`);
  else logger.warn(`Worker zarif kapatılamadı (${describeError(first.error)}); zorla kapatılıyor`);

  const forceBound = Math.min(ms, FORCE_CLOSE_BOUND_MS);
  const forced = await within(worker.close(true), forceBound);
  if (forced.kind === 'timeout') logger.error(`Worker zorla kapatma da ${forceBound} ms içinde bitmedi; kapanışa devam ediliyor`);
  else if (forced.kind === 'failed') logger.error(`Worker zorla kapatılamadı: ${describeError(forced.error)}`);
  return 'forced';
}
