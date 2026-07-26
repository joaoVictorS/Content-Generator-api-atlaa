import pino from 'pino';
import { env } from './config/env';
import { PrismaContentRepository } from './infrastructure/prisma/content.repository.prisma';
import { prisma } from './infrastructure/prisma/client';
import { createContentWorker } from './infrastructure/queue/content.worker';
import { s3Client } from './infrastructure/storage/s3.client';
import { S3Service } from './infrastructure/storage/s3.service';

const logger = pino({ level: env.LOG_LEVEL });

const contentRepository = new PrismaContentRepository(prisma);
const s3Service = new S3Service(s3Client);

const worker = createContentWorker(contentRepository, s3Service, logger);

worker.on('ready', () => logger.info('Content worker ready and listening for jobs'));
worker.on('error', (err) => logger.error({ err }, 'Worker error'));

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down worker');
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
