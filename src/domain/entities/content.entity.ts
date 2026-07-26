export const ContentStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  CANCELED: 'CANCELED',
  FAILED: 'FAILED',
} as const;

export type ContentStatus = (typeof ContentStatus)[keyof typeof ContentStatus];

export interface Content {
  id: string;
  topic: string;
  status: ContentStatus;
  fileUrl: string | null;
  errorMessage: string | null;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}
