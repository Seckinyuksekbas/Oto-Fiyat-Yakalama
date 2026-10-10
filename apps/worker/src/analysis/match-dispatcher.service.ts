import { Injectable } from '@nestjs/common';
import type { MatchEvent, MatchJobData } from '@oto/shared';
import { PrismaService } from '../infra/prisma.service';
import { RETRYING_JOB_OPTS } from '../queues/job-options';
import { QueueRegistry } from '../queues/queue-registry';

export interface PendingMatch {
  analysisId: number;
  listingId: number;
  event: MatchEvent;
  previousPrice: bigint | null;
}

export function matchJobId(analysisId: number): string {
  return `match-${analysisId}`;
}

@Injectable()
export class MatchDispatcher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
  ) {}

  /** Kuyruğa ekler ve analize `matchQueuedAt` yazar. jobId analiz başına tekil olduğundan tekrar çağrı güvenlidir. */
  async dispatch(m: PendingMatch): Promise<void> {
    const data: MatchJobData = {
      listingId: m.listingId,
      analysisId: m.analysisId,
      event: m.event,
      ...(m.event === 'PRICE_DROP' && m.previousPrice !== null ? { previousPrice: m.previousPrice.toString() } : {}),
    };
    await this.queues.match.add('match', data, { jobId: matchJobId(m.analysisId), ...RETRYING_JOB_OPTS });
    await this.prisma.listingAnalysis.update({ where: { id: m.analysisId }, data: { matchQueuedAt: new Date() } });
  }
}
