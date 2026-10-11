import { RETRYING_JOB_OPTS as SHARED_RETRYING_JOB_OPTS } from '@oto/shared';
import type { JobsOptions } from 'bullmq';

/** Yeniden denenen işler: 5 deneme, üstel bekleme; tamamlanınca silinir (tekilleştirme yalnızca beklerken). */
export const RETRYING_JOB_OPTS: JobsOptions = { ...SHARED_RETRYING_JOB_OPTS };

/** Bildirim işleri: 5 deneme; başarısızlar 7 gün tutulur (admin yeniden deneyebilir); bekleme süreleri notifyBackoffMs (özel strateji) ile belirlenir. */
export const NOTIFY_JOB_OPTS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'custom' },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};
