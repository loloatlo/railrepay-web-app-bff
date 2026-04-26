/**
 * CORS middleware for web-app-bff
 *
 * Implements strict CORS policy:
 *   - Only origins in ALLOWED_ORIGINS env var are permitted
 *   - No wildcard (*) ever (credentials require explicit origin)
 *   - Access-Control-Allow-Credentials: true
 *   - Vary: Origin
 *   - Preflight (OPTIONS): 204 with allowed methods/headers + max-age 86400
 *
 * ADR references:
 *   ADR-023 — Web Channel BFF Architecture (CORS config)
 *   OQ-6    — Domain not yet purchased; no railrepay.co.uk in ALLOWED_ORIGINS
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { getLogger } from '../lib/logger.js';

const ALLOWED_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, X-Correlation-ID, X-App-Version';
const MAX_AGE = '86400';

/**
 * Creates the CORS middleware.
 *
 * Reads ALLOWED_ORIGINS from process.env at creation time so the origin list
 * is captured when createCorsMiddleware() is called. Tests set process.env
 * before calling createCorsMiddleware() and the captured list is used for all
 * subsequent requests handled by this middleware instance.
 *
 * @returns Express RequestHandler middleware
 */
export function createCorsMiddleware(): RequestHandler {
  const logger = getLogger();

  // Capture allowed origins at creation time (not request time).
  // Tests override process.env.ALLOWED_ORIGINS before calling createCorsMiddleware().
  const allowedOriginsRaw = process.env.ALLOWED_ORIGINS ?? '';
  const allowedOrigins = allowedOriginsRaw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  return function corsMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {

    const origin = req.headers['origin'] as string | undefined;

    // Always set Vary: Origin (caching correctness)
    res.setHeader('Vary', 'Origin');

    if (origin && allowedOrigins.includes(origin)) {
      // Allowed origin — set CORS headers
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');

      if (req.method === 'OPTIONS') {
        // Preflight response
        res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
        res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
        res.setHeader('Access-Control-Max-Age', MAX_AGE);

        logger.info('CORS preflight allowed', {
          component: 'web-app-bff/cors',
          origin,
        });

        res.status(204).end();
        return;
      }
    } else if (origin) {
      // Unlisted origin — do not set ACAO header (effectively rejects CORS access)
      logger.warn('CORS request from unlisted origin rejected', {
        component: 'web-app-bff/cors',
        origin,
      });
    }

    next();
  };
}
