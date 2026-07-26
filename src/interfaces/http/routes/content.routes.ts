import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ContentService } from '../../../application/services/content.service';
import {
  cancelContentResponseSchema,
  contentIdParamsSchema,
  contentResponseSchema,
  errorResponseSchema,
  generateContentBodySchema,
  generateContentResponseSchema,
} from '../../../application/dto/content.schemas';

export async function contentRoutes(
  app: FastifyInstance,
  options: { contentService: ContentService },
): Promise<void> {
  const { contentService } = options;
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    '/api/content/generate',
    {
      schema: {
        tags: ['content'],
        summary: 'Solicita a geracao de um novo conteudo (assincrono)',
        body: generateContentBodySchema,
        response: {
          201: generateContentResponseSchema,
          402: errorResponseSchema,
          400: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const content = await contentService.generate(request.body);
      return reply.status(201).send({ contentId: content.id, status: content.status });
    },
  );

  server.get(
    '/api/content/:id',
    {
      schema: {
        tags: ['content'],
        summary: 'Consulta o status e o resultado de um conteudo',
        params: contentIdParamsSchema,
        response: {
          200: contentResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) => {
      return contentService.getById(request.params.id);
    },
  );

  server.post(
    '/api/content/:id/cancel',
    {
      schema: {
        tags: ['content'],
        summary: 'Cancela a geracao de um conteudo ainda pendente ou em processamento',
        params: contentIdParamsSchema,
        response: {
          200: cancelContentResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const content = await contentService.cancel(request.params.id);
      return { id: content.id, status: content.status };
    },
  );
}
