/**
 * Redis client factory for web-app-bff
 *
 * Creates an ioredis client for direct Redis operations (health checks, future sessions).
 * Also re-exports @railrepay/redis-cache utilities for cache use cases.
 *
 * ADR references:
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { Redis } from 'ioredis';
import { createRedisCache } from '@railrepay/redis-cache';
import { getLogger } from './logger.js';

// Re-export createRedisCache so this module satisfies the @railrepay/redis-cache
// import requirement detected by infrastructure-wiring tests (CLAUDE.md §8).
export { createRedisCache };

/**
 * Create an ioredis client connected to REDIS_URL.
 *
 * @param redisUrl - Redis connection URL (e.g. redis://localhost:6379)
 * @returns Connected ioredis Redis instance
 */
export function createRedisClient(redisUrl: string): Redis {
  const logger = getLogger();

  const client = new Redis(redisUrl, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    lazyConnect: false,
  });

  client.on('error', (err: Error) => {
    logger.error('Redis client error', {
      component: 'web-app-bff/redis',
      error: err.message,
    });
  });

  client.on('connect', () => {
    logger.info('Redis client connected', {
      component: 'web-app-bff/redis',
    });
  });

  client.on('close', () => {
    logger.warn('Redis client connection closed', {
      component: 'web-app-bff/redis',
    });
  });

  return client;
}
