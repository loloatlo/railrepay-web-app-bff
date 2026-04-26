/**
 * Health route for web-app-bff
 *
 * GET / returns:
 *   200 { status: 'ok', dependencies: { auth_service: 'reachable', redis: 'reachable' } }
 *       when both Redis and auth-service are reachable.
 *   503 { status: 'degraded', dependencies: { ... } }
 *       when either dependency is unreachable.
 *
 * Timeouts:
 *   auth-service: 2 seconds (AbortController)
 *   Redis ping:   1 second
 *
 * ADR references:
 *   ADR-008 — Health check endpoint contract
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { Router, type Request, type Response } from 'express';
import { type Redis } from 'ioredis';
import { getLogger } from '../lib/logger.js';

export interface HealthRouterOptions {
  /** Base URL of the auth-service (e.g. http://auth-service:3000) */
  authServiceUrl: string;
}

/**
 * Check Redis reachability with a 1-second timeout.
 *
 * @param redis - ioredis client instance
 * @returns 'reachable' or 'unreachable'
 */
async function checkRedis(redis: { ping: () => Promise<string> }): Promise<'reachable' | 'unreachable'> {
  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Redis ping timeout')), 1000)
    );
    await Promise.race([redis.ping(), timeoutPromise]);
    return 'reachable';
  } catch {
    return 'unreachable';
  }
}

/**
 * Check auth-service reachability with a 2-second timeout.
 *
 * Uses Promise.race so fake timers in tests can advance past the 2s boundary
 * and have the timeout reject before the fetch mock resolves/rejects.
 *
 * @param authServiceUrl - Base URL of the auth-service
 * @returns 'reachable' or 'unreachable'
 */
async function checkAuthService(authServiceUrl: string): Promise<'reachable' | 'unreachable'> {
  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('auth-service health check timeout')), 2000)
    );
    const fetchPromise = fetch(`${authServiceUrl}/health`).then((response) => {
      if (!response.ok) {
        throw new Error(`auth-service responded with ${response.status}`);
      }
      return response;
    });
    await Promise.race([fetchPromise, timeoutPromise]);
    return 'reachable';
  } catch {
    return 'unreachable';
  }
}

/**
 * Creates the health check router for web-app-bff.
 *
 * @param redis - ioredis client (injected for testability)
 * @param opts  - Health router options (authServiceUrl injected for testability)
 * @returns Express Router with GET / handler
 */
export function createHealthRouter(
  redis: Pick<Redis, 'ping'>,
  opts: HealthRouterOptions
): Router {
  const logger = getLogger();
  const router = Router();

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    logger.info('Health check requested', {
      component: 'web-app-bff/health',
    });

    // Run both checks in parallel for performance (AC-12: within 2s)
    const [redisStatus, authStatus] = await Promise.all([
      checkRedis(redis),
      checkAuthService(opts.authServiceUrl),
    ]);

    const allHealthy = redisStatus === 'reachable' && authStatus === 'reachable';

    const body = {
      status: allHealthy ? 'ok' : 'degraded',
      dependencies: {
        auth_service: authStatus,
        redis: redisStatus,
      },
    };

    logger.info('Health check result', {
      component: 'web-app-bff/health',
      status: body.status,
      dependencies: body.dependencies,
    });

    res.status(allHealthy ? 200 : 503).json(body);
  });

  return router;
}
