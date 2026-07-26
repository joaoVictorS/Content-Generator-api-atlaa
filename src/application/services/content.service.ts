import { Content } from '../../domain/entities/content.entity';
import { InvalidStateTransitionError, NotFoundError } from '../../domain/errors/app-error';
import { IContentRepository } from '../../domain/repositories/content.repository';
import { IContentQueue } from '../ports/content-queue.port';

export class ContentService {
  constructor(
    private readonly contentRepository: IContentRepository,
    private readonly contentQueue: IContentQueue,
  ) {}

  async generate(input: { topic: string; userId: string }): Promise<Content> {
    // Credit deduction + content creation happen atomically inside the
    // repository (single DB transaction). Only after that transaction has
    // committed do we enqueue the background job — this avoids enqueuing
    // work for a request whose credit charge might still roll back.
    const content = await this.contentRepository.createWithCreditCharge(input);
    await this.contentQueue.enqueueGeneration(content.id);
    return content;
  }

  async getById(id: string): Promise<Content> {
    const content = await this.contentRepository.findById(id);
    if (!content) {
      throw new NotFoundError(`Content ${id} not found`);
    }
    return content;
  }

  async cancel(id: string): Promise<Content> {
    // Atomic conditional update: only succeeds if content is still
    // PENDING or PROCESSING. If the worker already finished (COMPLETED)
    // or another cancel already happened, this returns null and we
    // surface a 409 instead of silently succeeding.
    const canceled = await this.contentRepository.cancel(id);
    if (!canceled) {
      const existing = await this.contentRepository.findById(id);
      if (!existing) {
        throw new NotFoundError(`Content ${id} not found`);
      }
      throw new InvalidStateTransitionError(
        `Content ${id} cannot be canceled from status ${existing.status}`,
      );
    }
    return canceled;
  }
}
