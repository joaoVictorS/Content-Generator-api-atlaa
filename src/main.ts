import { ContentService } from './application/services/content.service';
import { env } from './config/env';
import { PrismaContentRepository } from './infrastructure/prisma/content.repository.prisma';
import { prisma } from './infrastructure/prisma/client';
import { BullMqContentQueue } from './infrastructure/queue/content.queue';
import { buildServer } from './interfaces/http/server';

async function main(): Promise<void> {
  const contentRepository = new PrismaContentRepository(prisma);
  const contentQueue = new BullMqContentQueue();
  const contentService = new ContentService(contentRepository, contentQueue);

  const app = await buildServer(contentService);

  await app.listen({ host: '0.0.0.0', port: env.PORT });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Shutting down API');
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal error starting API', err);
  process.exit(1);
});
