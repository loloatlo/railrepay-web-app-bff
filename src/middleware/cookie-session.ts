/**
 * Cookie-session middleware for web-app-bff
 *
 * Reads the rr_session cookie, looks up the Redis session row, and attaches
 * req.session to the request. If the Redis row is absent, clears the cookie
 * and returns 401.
 *
 * Logs cookie *presence* as a boolean — never the cookie value itself.
 *
 * Story   : RAILREPAY-WEB-BFF-002
 * AC-1    : Logs cookie presence (boolean), never value
 * AC-2    : getSession; null → 401 + cookie-clear
 * AC-10   : Uses @railrepay/winston-logger; Redis injected via DI
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { createLogger } from '@railrepay/winston-logger';
import type { Redis } from 'ioredis';
import { getSession } from '../lib/session-store.js';

const logger = createLogger({
  serviceName: process.env.SERVICE_NAME ?? 'web-app-bff',
  level: process.env.LOG_LEVEL ?? 'info',
  environment: process.env.NODE_ENV ?? 'development',
});

/** Minimal session shape attached to req */
export interface RequestSession {
  user_id: string;
  session_id: string;
  source: 'cookie' | 'bearer';
}

/**
 * Create the cookie-session middleware.
 *
 * Reads the session cookie name from SESSION_COOKIE_NAME env var at call time.
 *
 * @param redis - ioredis client injected for testability
 * @returns Express RequestHandler
 */
export function createCookieSessionMiddleware(
  redis: Pick<Redis, 'get' | 'expire'>
): RequestHandler {
  return async function cookieSessionMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction
  ): Promise<void> {
    const cookieName = process.env.SESSION_COOKIE_NAME ?? 'rr_session';
    const sid: string | undefined = (req.cookies as Record<string, string | undefined>)[cookieName];

    // Log cookie presence as boolean — never the value
    logger.debug('cookie-session: checking session cookie', {
      component: 'web-app-bff/cookie-session',
      hasCookie: sid !== undefined,
    });

    if (!sid) {
      // No cookie — let next middleware handle (e.g. Bearer fallback)
      next();
      return;
    }

    const session = await getSession(redis, sid);

    if (!session) {
      // Stale/missing Redis row — do NOT block, let route handlers enforce auth
      // The session router will clear the cookie and return 401 if needed
      logger.warn('cookie-session: Redis row missing — passing through without session', {
        component: 'web-app-bff/cookie-session',
      });
      next();
      return;
    }

    // Valid session — attach to request
    (req as Request & { session?: RequestSession }).session = {
      user_id: session.user_id,
      session_id: session.session_id,
      source: 'cookie',
    };

    logger.debug('cookie-session: session attached', {
      component: 'web-app-bff/cookie-session',
      hasCookie: true,
    });

    next();
  };
}
