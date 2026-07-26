import { z } from 'zod';

export const contentStatusSchema = z.enum([
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'CANCELED',
  'FAILED',
]);

export const generateContentBodySchema = z.object({
  topic: z.string().min(3, 'topic must have at least 3 characters'),
  userId: z.string().uuid('userId must be a valid uuid'),
});
export type GenerateContentBody = z.infer<typeof generateContentBodySchema>;

export const generateContentResponseSchema = z.object({
  contentId: z.string().uuid(),
  status: contentStatusSchema,
});

export const contentIdParamsSchema = z.object({
  id: z.string().uuid('id must be a valid uuid'),
});
export type ContentIdParams = z.infer<typeof contentIdParamsSchema>;

export const contentResponseSchema = z.object({
  id: z.string().uuid(),
  topic: z.string(),
  userId: z.string().uuid(),
  status: contentStatusSchema,
  fileUrl: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const cancelContentResponseSchema = z.object({
  id: z.string().uuid(),
  status: contentStatusSchema,
});

export const errorResponseSchema = z.object({
  statusCode: z.number(),
  code: z.string(),
  message: z.string(),
});
