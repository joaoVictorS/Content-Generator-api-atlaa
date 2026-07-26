import { Queue } from 'bullmq';
import { IContentQueue } from '../../application/ports/content-queue.port';
import { CONTENT_GENERATION_QUEUE, redisConnection } from './connection';

export interface ContentGenerationJobData {
  contentId: string;
}

export const contentGenerationQueue = new Queue<ContentGenerationJobData>(
  CONTENT_GENERATION_QUEUE,
  { connection: redisConnection },
);

export class BullMqContentQueue implements IContentQueue {
  async enqueueGeneration(contentId: string): Promise<void> {
    await contentGenerationQueue.add(
      'generate',
      { contentId },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    );
  }
}
