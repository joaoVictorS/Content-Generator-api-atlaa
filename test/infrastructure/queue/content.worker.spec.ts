import { describe, expect, it, vi } from 'vitest';
import {
  ContentWorkerDeps,
  handleJobFailed,
  processContentGenerationJob,
} from '../../../src/infrastructure/queue/content.worker';
import { Content, ContentStatus } from '../../../src/domain/entities/content.entity';
import { IContentRepository } from '../../../src/domain/repositories/content.repository';

function makeContent(overrides: Partial<Content> = {}): Content {
  return {
    id: 'content-1',
    topic: 'topic',
    status: ContentStatus.PENDING,
    fileUrl: null,
    errorMessage: null,
    userId: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeFakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}

function makeFakeS3Service() {
  return { uploadTextFile: vi.fn().mockResolvedValue('http://s3/file.txt') } as any;
}

/** Configurable fake so each test controls exactly what each CAS call returns. */
function makeFakeContentRepository(overrides: Partial<IContentRepository> = {}): IContentRepository {
  return {
    createWithCreditCharge: vi.fn(),
    findById: vi.fn(),
    markProcessing: vi.fn(),
    markCompleted: vi.fn(),
    markFailed: vi.fn(),
    cancel: vi.fn(),
    ...overrides,
  };
}

describe('processContentGenerationJob', () => {
  it('does nothing when the content no longer exists', async () => {
    const contentRepository = makeFakeContentRepository({ findById: vi.fn().mockResolvedValue(null) });
    const generateText = vi.fn();

    await processContentGenerationJob(
      { contentRepository, s3Service: makeFakeS3Service(), logger: makeFakeLogger(), generateText },
      'missing-id',
    );

    expect(generateText).not.toHaveBeenCalled();
  });

  it.each([ContentStatus.CANCELED, ContentStatus.COMPLETED, ContentStatus.FAILED])(
    'skips processing entirely when content is already %s',
    async (status) => {
      const contentRepository = makeFakeContentRepository({
        findById: vi.fn().mockResolvedValue(makeContent({ status })),
      });
      const generateText = vi.fn();

      await processContentGenerationJob(
        { contentRepository, s3Service: makeFakeS3Service(), logger: makeFakeLogger(), generateText },
        'content-1',
      );

      expect(generateText).not.toHaveBeenCalled();
      expect(contentRepository.markProcessing).not.toHaveBeenCalled();
    },
  );

  it('aborts without calling the AI when /cancel wins the race before processing starts', async () => {
    const contentRepository = makeFakeContentRepository({
      findById: vi.fn().mockResolvedValue(makeContent({ status: ContentStatus.PENDING })),
      markProcessing: vi.fn().mockResolvedValue(null), // raced with /cancel
    });
    const generateText = vi.fn();

    await processContentGenerationJob(
      { contentRepository, s3Service: makeFakeS3Service(), logger: makeFakeLogger(), generateText },
      'content-1',
    );

    expect(generateText).not.toHaveBeenCalled();
  });

  it('runs the AI call directly on a retry (content already PROCESSING) without re-marking it', async () => {
    const contentRepository = makeFakeContentRepository({
      findById: vi.fn().mockResolvedValue(makeContent({ status: ContentStatus.PROCESSING })),
      markCompleted: vi.fn().mockResolvedValue(makeContent({ status: ContentStatus.COMPLETED })),
    });
    const generateText = vi.fn().mockResolvedValue('generated text');
    const s3Service = makeFakeS3Service();

    await processContentGenerationJob(
      { contentRepository, s3Service, logger: makeFakeLogger(), generateText },
      'content-1',
    );

    expect(contentRepository.markProcessing).not.toHaveBeenCalled();
    expect(generateText).toHaveBeenCalledWith('topic');
    expect(s3Service.uploadTextFile).toHaveBeenCalledWith('contents/content-1.txt', 'generated text');
  });

  it('discards the generated result instead of resurrecting a job canceled mid-flight', async () => {
    // This is the critical concurrency scenario from spec.md 5.2: the AI
    // call and S3 upload both succeed, but /cancel already flipped the
    // status away from PROCESSING by the time we try to complete it.
    const contentRepository = makeFakeContentRepository({
      findById: vi.fn().mockResolvedValue(makeContent({ status: ContentStatus.PENDING })),
      markProcessing: vi.fn().mockResolvedValue(makeContent({ status: ContentStatus.PROCESSING })),
      markCompleted: vi.fn().mockResolvedValue(null), // CAS failed: already CANCELED
    });
    const generateText = vi.fn().mockResolvedValue('generated text');
    const logger = makeFakeLogger();

    await expect(
      processContentGenerationJob(
        { contentRepository, s3Service: makeFakeS3Service(), logger, generateText },
        'content-1',
      ),
    ).resolves.not.toThrow();

    expect(contentRepository.markCompleted).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ contentId: 'content-1' }),
      expect.stringContaining('discarding generated result'),
    );
  });

  it('propagates AI failures so BullMQ can retry the job', async () => {
    const contentRepository = makeFakeContentRepository({
      findById: vi.fn().mockResolvedValue(makeContent({ status: ContentStatus.PROCESSING })),
    });
    const generateText = vi.fn().mockRejectedValue(new Error('AI exploded'));

    await expect(
      processContentGenerationJob(
        { contentRepository, s3Service: makeFakeS3Service(), logger: makeFakeLogger(), generateText },
        'content-1',
      ),
    ).rejects.toThrow('AI exploded');

    expect(contentRepository.markCompleted).not.toHaveBeenCalled();
  });
});

describe('handleJobFailed', () => {
  function makeJob(attemptsMade: number, attempts: number, contentId = 'content-1') {
    return { attemptsMade, opts: { attempts }, data: { contentId } } as any;
  }

  it('does nothing when there is no job', async () => {
    const contentRepository = makeFakeContentRepository();

    await handleJobFailed({ contentRepository, logger: makeFakeLogger() }, undefined, new Error('x'));

    expect(contentRepository.markFailed).not.toHaveBeenCalled();
  });

  it('does not mark FAILED while retries remain', async () => {
    const contentRepository = makeFakeContentRepository();

    await handleJobFailed(
      { contentRepository, logger: makeFakeLogger() },
      makeJob(1, 3),
      new Error('transient'),
    );

    expect(contentRepository.markFailed).not.toHaveBeenCalled();
  });

  it('marks FAILED once every retry attempt is exhausted', async () => {
    const contentRepository = makeFakeContentRepository();

    await handleJobFailed(
      { contentRepository, logger: makeFakeLogger() },
      makeJob(3, 3),
      new Error('permanent'),
    );

    expect(contentRepository.markFailed).toHaveBeenCalledWith('content-1', 'permanent');
  });

  it('never throws even if persisting the FAILED status itself fails', async () => {
    const contentRepository = makeFakeContentRepository({
      markFailed: vi.fn().mockRejectedValue(new Error('db down')),
    });

    await expect(
      handleJobFailed({ contentRepository, logger: makeFakeLogger() }, makeJob(3, 3), new Error('permanent')),
    ).resolves.not.toThrow();
  });
});
