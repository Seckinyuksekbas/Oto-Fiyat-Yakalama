import type { JobsOptions } from 'bullmq';

/** Yeniden denenen işler: 5 deneme, üstel bekleme; tamamlanınca silinir (tekilleştirme yalnızca beklerken). */
export const RETRYING_JOB_OPTS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: true,
  removeOnFail: { age: 24 * 60 * 60 },
};

/** Bildirim işleri: 5 deneme; bekleme süreleri notifyBackoffMs (özel strateji) ile belirlenir. */
export const NOTIFY_JOB_OPTS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'custom' },
  removeOnComplete: true,
  removeOnFail: { age: 24 * 60 * 60 },
};
