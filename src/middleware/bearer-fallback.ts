/**
 * Bearer-fallback middleware for web-app-bff
 *
 * When no rr_session cookie is present (cookie-session middleware did not
 * populate req.session), attempts to verify an Authorization: Bearer <jwt>
 * token using HS256 and the JWT_SECRET env var.
 *
 * On valid token → attaches req.session = {user_id, session_id, source:'bearer'}
 * On invalid/expired/absent token → 401 {error: 'unauthorized'}
 * When rr_session cookie IS present → skips JWT verification and calls next()
 *   (cookie-session wins; this middleware is a fallback only)
 *
 * Story   : RAILREPAY-WEB-BFF-002
 * AC-7    : Bearer extraction + local HS256 verify via jose
 * AC-10   : Cookie takes precedence over Bearer (mutually exclusive)
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { jwtVerify } from 'jose';
import { createLogger } from '@railrepay/winston-logger';
import type { RequestSession } from './cookie-session.js';

const logger = createLogger({
  serviceName: process.env.SERVICE_NAME ?? 'web-app-bff',
  level: process.env.LOG_LEVEL ?? 'info',
  environment: process.env.NODE_ENV ?? 'development',
});

/**
 * Create the Bearer-fallback middleware.
 *
 * Reads JWT_SECRET, JWT_ISSUER, JWT_AUDIENCE from process.env at request time
 * so that tests can control env vars via beforeEach/afterEach.
 *
 * @returns Express RequestHandler
 */
export function createBearerFallbackMiddleware(): RequestHandler {
  return async function bearerFallbackMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const cookieName = process.env.SESSION_COOKIE_NAME ?? 'rr_session';
    const cookies = req.cookies as Record<string, string | undefined>;

    // Cookie takes precedence — skip JWT verification if cookie is present
    if (cookies[cookieName] !== undefined) {
      logger.debug('bearer-fallback: rr_session cookie present — skipping JWT verification', {
        component: 'web-app-bff/bearer-fallback',
      });
      next();
      return;
    }

    // Skip if req.session already populated (another middleware set it)
    const typedReq = req as Request & { session?: RequestSession };
    if (typedReq.session) {
      next();
      return;
    }

    // Extract Bearer token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.debug('bearer-fallback: no Authorization header', {
        component: 'web-app-bff/bearer-fallback',
      });
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const token = authHeader.slice('Bearer '.length).trim();

    // Read JWT config from env at request time
    const jwtSecretRaw = process.env.JWT_SECRET ?? '';
    const jwtIssuer = process.env.JWT_ISSUER ?? 'auth-service';
    const jwtAudience = process.env.JWT_AUDIENCE ?? 'web-app-bff';

    if (!jwtSecretRaw) {
      logger.error('bearer-fallback: JWT_SECRET not configured', {
        component: 'web-app-bff/bearer-fallback',
      });
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const secretBytes = new TextEncoder().encode(jwtSecretRaw);

    try {
      const { payload } = await jwtVerify(token, secretBytes, {
        issuer: jwtIssuer,
        audience: jwtAudience,
        algorithms: ['HS256'],
      });

      // Attach session from JWT claims
      const userId = payload.sub;
      const sessionId = payload.sid as string | undefined;

      if (!userId) {
        logger.warn('bearer-fallback: JWT missing sub claim', {
          component: 'web-app-bff/bearer-fallback',
        });
        res.status(401).json({ error: 'unauthorized' });
        return;
      }

      typedReq.session = {
        user_id: userId,
        session_id: sessionId ?? '',
        source: 'bearer',
      };

      logger.debug('bearer-fallback: JWT verified — session attached', {
        component: 'web-app-bff/bearer-fallback',
        source: 'bearer',
      });

      next();
    } catch {
      logger.debug('bearer-fallback: JWT verification failed', {
        component: 'web-app-bff/bearer-fallback',
      });
      res.status(401).json({ error: 'unauthorized' });
    }
  };
}
