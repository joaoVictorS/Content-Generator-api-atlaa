import { ConnectionOptions } from 'bullmq';
import { env } from '../../config/env';

export const redisConnection: ConnectionOptions = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  maxRetriesPerRequest: null,
};

export const CONTENT_GENERATION_QUEUE = 'content-generation';
