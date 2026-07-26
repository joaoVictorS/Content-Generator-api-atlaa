import { Job, Worker } from 'bullmq';
import type { Logger } from 'pino';
import { ContentStatus } from '../../domain/entities/content.entity';
import { IContentRepository } from '../../domain/repositories/content.repository';
import { simulateAIGeneration } from '../ai/ai-simulator';
import { S3Service } from '../storage/s3.service';
import { CONTENT_GENERATION_QUEUE, redisConnection } from './connection';
import type { ContentGenerationJobData } from './content.queue';

const WORKER_CONCURRENCY = 5;

export type GenerateTextFn = (topic: string) => Promise<string>;

export interface ContentWorkerDeps {
  contentRepository: IContentRepository;
  s3Service: S3Service;
  logger: Logger;
  generateText?: GenerateTextFn;
}

/**
 * Core processing logic for a single job, extracted from the BullMQ
 * callback so it can be unit tested without a real Redis/Worker instance.
 * Implements the CAS guards described in spec.md 5.2/5.3: a concurrent
 * /cancel at any point (before processing starts, or after the 5s AI call
 * finishes) always wins over the worker.
 */
export async function processContentGenerationJob(
  deps: ContentWorkerDeps,
  contentId: string,
): Promise<void> {
  const { contentRepository, s3Service, logger, generateText = simulateAIGeneration } = deps;

  const content = await contentRepository.findById(contentId);
  if (!content) {
    // Not a transient failure - retrying won't make the row appear.
    logger.error({ contentId }, 'Content not found, aborting job');
    return;
  }

  // Terminal states reached by a concurrent /cancel (or an earlier,
  // already-finished attempt) are never touched again. This is what
  // stops the worker from "resurrecting" a job the user canceled.
  if (
    content.status === ContentStatus.CANCELED ||
    content.status === ContentStatus.COMPLETED ||
    content.status === ContentStatus.FAILED
  ) {
    logger.info({ contentId, status: content.status }, 'Content already in a terminal state, skipping');
    return;
  }

  if (content.status === ContentStatus.PENDING) {
    // First attempt: CAS PENDING -> PROCESSING.
    const processing = await contentRepository.markProcessing(contentId);
    if (!processing) {
      // Raced with a /cancel between findById and markProcessing above.
      logger.info({ contentId }, 'Content was canceled right before processing started');
      return;
    }
  }
  // If status is already PROCESSING, this is a BullMQ retry after a
  // previous AI-simulation failure - proceed straight to the AI call.

  const text = await generateText(content.topic);

  const fileUrl = await s3Service.uploadTextFile(`contents/${contentId}.txt`, text);

  // CAS PROCESSING -> COMPLETED. If this returns null, /cancel won the
  // race while the 5s AI call (or the upload) was in flight - the
  // freshly generated file is discarded and the CANCELED status stands.
  const completed = await contentRepository.markCompleted(contentId, fileUrl);
  if (!completed) {
    logger.warn(
      { contentId },
      'Content was canceled while processing finished; discarding generated result',
    );
  }
}

/**
 * Handles a BullMQ 'failed' event: only marks the content as FAILED once
 * all retry attempts are exhausted, and never lets a persistence error
 * here crash the worker process.
 */
export async function handleJobFailed(
  deps: Pick<ContentWorkerDeps, 'contentRepository' | 'logger'>,
  job: Job<ContentGenerationJobData> | undefined,
  err: Error,
): Promise<void> {
  if (!job) return;
  const { contentRepository, logger } = deps;

  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < maxAttempts) {
    // More retries scheduled by BullMQ - content stays PROCESSING.
    logger.warn(
      { contentId: job.data.contentId, attempt: job.attemptsMade, err: err.message },
      'AI generation attempt failed, will retry',
    );
    return;
  }

  logger.error(
    { contentId: job.data.contentId, err: err.message },
    'AI generation exhausted all retries, marking content as FAILED',
  );
  try {
    // CAS PROCESSING -> FAILED. No-op if the content was canceled meanwhile.
    await contentRepository.markFailed(job.data.contentId, err.message);
  } catch (markFailedErr) {
    // A failure here must not crash the worker process - BullMQ has
    // already recorded the job as failed; just log and move on.
    logger.error({ contentId: job.data.contentId, err: markFailedErr }, 'Failed to persist FAILED status');
  }
}

export function createContentWorker(
  contentRepository: IContentRepository,
  s3Service: S3Service,
  logger: Logger,
): Worker<ContentGenerationJobData> {
  const deps: ContentWorkerDeps = { contentRepository, s3Service, logger };

  const worker = new Worker<ContentGenerationJobData>(
    CONTENT_GENERATION_QUEUE,
    async (job: Job<ContentGenerationJobData>) => processContentGenerationJob(deps, job.data.contentId),
    {
      connection: redisConnection,
      concurrency: WORKER_CONCURRENCY,
    },
  );

  worker.on('failed', (job, err) => void handleJobFailed(deps, job, err));

  return worker;
}
