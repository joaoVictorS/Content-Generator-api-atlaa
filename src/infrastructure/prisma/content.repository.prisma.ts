import { PrismaClient } from '@prisma/client';
import { Content, ContentStatus } from '../../domain/entities/content.entity';
import { InsufficientCreditsError } from '../../domain/errors/app-error';
import { CreateContentInput, IContentRepository } from '../../domain/repositories/content.repository';

interface ContentRow {
  id: string;
  topic: string;
  status: string;
  fileUrl: string | null;
  errorMessage: string | null;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}

function toEntity(row: ContentRow): Content {
  return {
    id: row.id,
    topic: row.topic,
    status: row.status as ContentStatus,
    fileUrl: row.fileUrl,
    errorMessage: row.errorMessage,
    userId: row.userId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PrismaContentRepository implements IContentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createWithCreditCharge(input: CreateContentInput): Promise<Content> {
    return this.prisma.$transaction(async (tx) => {
      // Single atomic UPDATE ... WHERE credits > 0: two concurrent requests
      // for the same user serialize on this row, so only one can ever
      // succeed when the balance is exactly 1. No read-then-write race.
      const updated = await tx.user.updateMany({
        where: { id: input.userId, credits: { gt: 0 } },
        data: { credits: { decrement: 1 } },
      });

      if (updated.count === 0) {
        throw new InsufficientCreditsError();
      }

      const content = await tx.content.create({
        data: {
          topic: input.topic,
          userId: input.userId,
          status: 'PENDING',
        },
      });

      return toEntity(content as ContentRow);
    });
  }

  async findById(id: string): Promise<Content | null> {
    const row = await this.prisma.content.findUnique({ where: { id } });
    return row ? toEntity(row as ContentRow) : null;
  }

  async markProcessing(id: string): Promise<Content | null> {
    const rows = await this.prisma.$queryRaw<ContentRow[]>`
      UPDATE contents
      SET status = 'PROCESSING', "updatedAt" = now()
      WHERE id = ${id} AND status = 'PENDING'
      RETURNING id, topic, status, "fileUrl", "errorMessage", "userId", "createdAt", "updatedAt"
    `;
    return rows[0] ? toEntity(rows[0]) : null;
  }

  async markCompleted(id: string, fileUrl: string): Promise<Content | null> {
    const rows = await this.prisma.$queryRaw<ContentRow[]>`
      UPDATE contents
      SET status = 'COMPLETED', "fileUrl" = ${fileUrl}, "updatedAt" = now()
      WHERE id = ${id} AND status = 'PROCESSING'
      RETURNING id, topic, status, "fileUrl", "errorMessage", "userId", "createdAt", "updatedAt"
    `;
    return rows[0] ? toEntity(rows[0]) : null;
  }

  async markFailed(id: string, errorMessage: string): Promise<Content | null> {
    const rows = await this.prisma.$queryRaw<ContentRow[]>`
      UPDATE contents
      SET status = 'FAILED', "errorMessage" = ${errorMessage}, "updatedAt" = now()
      WHERE id = ${id} AND status = 'PROCESSING'
      RETURNING id, topic, status, "fileUrl", "errorMessage", "userId", "createdAt", "updatedAt"
    `;
    return rows[0] ? toEntity(rows[0]) : null;
  }

  async cancel(id: string): Promise<Content | null> {
    const rows = await this.prisma.$queryRaw<ContentRow[]>`
      UPDATE contents
      SET status = 'CANCELED', "updatedAt" = now()
      WHERE id = ${id} AND status IN ('PENDING', 'PROCESSING')
      RETURNING id, topic, status, "fileUrl", "errorMessage", "userId", "createdAt", "updatedAt"
    `;
    return rows[0] ? toEntity(rows[0]) : null;
  }
}
