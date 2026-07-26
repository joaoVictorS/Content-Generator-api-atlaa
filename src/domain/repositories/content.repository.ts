import { Content } from '../entities/content.entity';

export interface CreateContentInput {
  topic: string;
  userId: string;
}

/**
 * All state-transition methods are implemented as atomic conditional updates
 * (UPDATE ... WHERE status = expected) so concurrent writers (API vs Worker)
 * never race on a read-then-write. A `null` return means the expected
 * precondition was not met (e.g. already canceled) — callers must treat that
 * as "no-op", not as an unexpected error.
 */
export interface IContentRepository {
  /**
   * Atomically deducts 1 credit from the user and creates the Content row as
   * PENDING in a single transaction. Throws InsufficientCreditsError (domain)
   * if the user has no credits available.
   */
  createWithCreditCharge(input: CreateContentInput): Promise<Content>;

  findById(id: string): Promise<Content | null>;

  /** CAS: PENDING -> PROCESSING. Returns null if content is no longer PENDING. */
  markProcessing(id: string): Promise<Content | null>;

  /** CAS: PROCESSING -> COMPLETED. Returns null if content is no longer PROCESSING. */
  markCompleted(id: string, fileUrl: string): Promise<Content | null>;

  /** CAS: PROCESSING -> FAILED. Returns null if content is no longer PROCESSING. */
  markFailed(id: string, errorMessage: string): Promise<Content | null>;

  /** CAS: PENDING|PROCESSING -> CANCELED. Returns null if already in a terminal state. */
  cancel(id: string): Promise<Content | null>;
}
