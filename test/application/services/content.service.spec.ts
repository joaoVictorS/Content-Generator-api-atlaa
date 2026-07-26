import { beforeEach, describe, expect, it } from 'vitest';
import { ContentService } from '../../../src/application/services/content.service';
import { IContentQueue } from '../../../src/application/ports/content-queue.port';
import { Content, ContentStatus } from '../../../src/domain/entities/content.entity';
import {
  InsufficientCreditsError,
  InvalidStateTransitionError,
  NotFoundError,
} from '../../../src/domain/errors/app-error';
import {
  CreateContentInput,
  IContentRepository,
} from '../../../src/domain/repositories/content.repository';

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

/**
 * In-memory fake standing in for the Prisma repository. Exercises the
 * ContentService's orchestration logic in isolation, without a real DB -
 * the CAS semantics themselves are covered by the repository (integration
 * concern), this file covers what ContentService does with their results.
 */
class FakeContentRepository implements IContentRepository {
  public store = new Map<string, Content>();
  public creditedUsers = new Set<string>();
  public createWithCreditChargeCalls = 0;

  async createWithCreditCharge(input: CreateContentInput): Promise<Content> {
    this.createWithCreditChargeCalls += 1;
    if (!this.creditedUsers.has(input.userId)) {
      throw new InsufficientCreditsError();
    }
    const content = makeContent({ id: 'new-content', topic: input.topic, userId: input.userId });
    this.store.set(content.id, content);
    return content;
  }

  async findById(id: string): Promise<Content | null> {
    return this.store.get(id) ?? null;
  }

  async markProcessing(): Promise<Content | null> {
    throw new Error('not used in these tests');
  }

  async markCompleted(): Promise<Content | null> {
    throw new Error('not used in these tests');
  }

  async markFailed(): Promise<Content | null> {
    throw new Error('not used in these tests');
  }

  async cancel(id: string): Promise<Content | null> {
    const existing = this.store.get(id);
    if (!existing) return null;
    if (existing.status !== ContentStatus.PENDING && existing.status !== ContentStatus.PROCESSING) {
      return null;
    }
    const canceled = { ...existing, status: ContentStatus.CANCELED };
    this.store.set(id, canceled);
    return canceled;
  }
}

class FakeContentQueue implements IContentQueue {
  public enqueued: string[] = [];

  async enqueueGeneration(contentId: string): Promise<void> {
    this.enqueued.push(contentId);
  }
}

describe('ContentService', () => {
  let repository: FakeContentRepository;
  let queue: FakeContentQueue;
  let service: ContentService;

  beforeEach(() => {
    repository = new FakeContentRepository();
    queue = new FakeContentQueue();
    service = new ContentService(repository, queue);
  });

  describe('generate', () => {
    it('creates the content and enqueues a background job when the user has credits', async () => {
      repository.creditedUsers.add('user-1');

      const content = await service.generate({ topic: 'AI', userId: 'user-1' });

      expect(content.status).toBe(ContentStatus.PENDING);
      expect(queue.enqueued).toEqual([content.id]);
    });

    it('propagates InsufficientCreditsError and never enqueues a job for a user without credits', async () => {
      await expect(service.generate({ topic: 'AI', userId: 'broke-user' })).rejects.toBeInstanceOf(
        InsufficientCreditsError,
      );

      expect(queue.enqueued).toEqual([]);
    });
  });

  describe('getById', () => {
    it('returns the content when it exists', async () => {
      const content = makeContent({ id: 'abc' });
      repository.store.set('abc', content);

      await expect(service.getById('abc')).resolves.toEqual(content);
    });

    it('throws NotFoundError when the content does not exist', async () => {
      await expect(service.getById('missing')).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('cancel', () => {
    it('cancels a PENDING content', async () => {
      repository.store.set('abc', makeContent({ id: 'abc', status: ContentStatus.PENDING }));

      const canceled = await service.cancel('abc');

      expect(canceled.status).toBe(ContentStatus.CANCELED);
    });

    it('cancels a PROCESSING content (worker mid-flight)', async () => {
      repository.store.set('abc', makeContent({ id: 'abc', status: ContentStatus.PROCESSING }));

      const canceled = await service.cancel('abc');

      expect(canceled.status).toBe(ContentStatus.CANCELED);
    });

    it('throws InvalidStateTransitionError when the content is already COMPLETED', async () => {
      repository.store.set('abc', makeContent({ id: 'abc', status: ContentStatus.COMPLETED }));

      await expect(service.cancel('abc')).rejects.toBeInstanceOf(InvalidStateTransitionError);
    });

    it('throws NotFoundError when the content does not exist', async () => {
      await expect(service.cancel('missing')).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
