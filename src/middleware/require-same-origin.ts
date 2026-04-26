/**
 * Require-same-origin middleware (CSRF origin check) for web-app-bff
 *
 * For state-changing HTTP methods (POST, PUT, PATCH, DELETE):
 *   - If Origin header is present AND not in ALLOWED_ORIGINS → 403 {error:'origin_forbidden'}
 *   - If Origin header is absent → next() (server-to-server calls allowed)
 *   - If Origin IS in ALLOWED_ORIGINS → next()
 *
 * For safe methods (GET, HEAD, OPTIONS) → always next() (bypass)
 *
 * Story   : RAILREPAY-WEB-BFF-002
 * AC-6    : Origin check on state-changing routes
 * CSRF    : SameSite=Lax + strict origin check; double-submit token deferred to TD
 *
 * ADR references:
 *   ADR-023 — Web Channel BFF Architecture
 *   OQ-3   — CSRF: SameSite=Lax + strict origin check on state-changing routes
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { createLogger } from '@railrepay/winston-logger';

const logger = createLogger({
  serviceName: process.env.SERVICE_NAME ?? 'web-app-bff',
  level: process.env.LOG_LEVEL ?? 'info',
  environment: process.env.NODE_ENV ?? 'development',
});

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Create the require-same-origin middleware.
 *
 * Reads ALLOWED_ORIGINS from process.env at call time. Tests set
 * process.env.ALLOWED_ORIGINS in beforeEach before calling createRequireSameOriginMiddleware().
 *
 * @returns Express RequestHandler
 */
export function createRequireSameOriginMiddleware(): RequestHandler {
  // Read allowed origins at creation time
  const allowedOriginsRaw = process.env.ALLOWED_ORIGINS ?? '';
  const allowedOrigins = allowedOriginsRaw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  return function requireSameOriginMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    // Safe methods bypass entirely
    if (!STATE_CHANGING_METHODS.has(req.method)) {
      next();
      return;
    }

    const origin = req.headers.origin as string | undefined;

    // No origin header — allow (server-to-server request)
    if (!origin) {
      next();
      return;
    }

    // Check if origin is in the allowed list
    if (allowedOrigins.includes(origin)) {
      next();
      return;
    }

    logger.warn('require-same-origin: forbidden origin on state-changing request', {
      component: 'web-app-bff/require-same-origin',
      origin,
      method: req.method,
    });

    res.status(403).json({ error: 'origin_forbidden' });
  };
}
