import type { JobsOptions } from 'bullmq';

/** Yeniden denenen işler: 5 deneme, üstel bekleme; tamamlanınca silinir (tekilleştirme yalnızca beklerken). */
export const RETRYING_JOB_OPTS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: true,
  removeOnFail: { age: 24 * 60 * 60 },
};
