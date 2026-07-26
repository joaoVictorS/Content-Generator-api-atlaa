/**
 * Outbound port for enqueuing background generation jobs. Kept independent
 * from BullMQ so the application layer doesn't depend on infrastructure.
 */
export interface IContentQueue {
  enqueueGeneration(contentId: string): Promise<void>;
}
