import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { FastifyInstance } from 'fastify';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

export async function registerSwagger(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'AI Content Generator API',
        description:
          'API para geracao assincrona de conteudo via IA (simulada), com fila BullMQ, ' +
          'upload em S3/Minio e controle de creditos por usuario.',
        version: '1.0.0',
      },
      tags: [{ name: 'content', description: 'Geracao e consulta de conteudo' }],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
  });
}
