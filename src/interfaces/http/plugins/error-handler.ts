import { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../../../domain/errors/app-error';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        statusCode: error.statusCode,
        code: error.code,
        message: error.message,
      });
      return;
    }

    if (error instanceof ZodError) {
      reply.status(400).send({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: error.issues.map((issue) => issue.message).join('; '),
      });
      return;
    }

    // Fastify's own schema-validation errors carry a validation array and a
    // statusCode < 500; treat them as client errors too.
    if (error.validation) {
      reply.status(400).send({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: error.message,
      });
      return;
    }

    // Anything else is unexpected: log full detail server-side, never leak
    // stack traces or internals to the client.
    request.log.error({ err: error }, 'Unhandled error');
    reply.status(500).send({
      statusCode: 500,
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      statusCode: 404,
      code: 'ROUTE_NOT_FOUND',
      message: `Route ${request.method} ${request.url} not found`,
    });
  });
}
