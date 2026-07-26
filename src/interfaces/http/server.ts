import Fastify, { FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { ContentService } from '../../application/services/content.service';
import { env } from '../../config/env';
import { registerErrorHandler } from './plugins/error-handler';
import { registerSwagger } from './plugins/swagger';
import { contentRoutes } from './routes/content.routes';

export async function buildServer(contentService: ContentService): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerErrorHandler(app);
  await registerSwagger(app);

  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(contentRoutes, { contentService });

  return app;
}
