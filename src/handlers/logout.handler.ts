/**
 * Handler: POST /api/auth/logout
 *
 * Reads rr_session cookie directly (plus req.session from middleware for the
 * access_token lookup). Performs best-effort auth-service revoke, then
 * always deletes the Redis row and clears the cookie.
 *
 * Idempotent: second call with no cookie returns 204 immediately.
 * Failure tolerant: auth-service revoke errors are swallowed (AC-4.3 UX hardening).
 *
 * Story   : RAILREPAY-WEB-BFF-003
 * AC-4.1  : calls POST /auth/sessions/revoke, deletes Redis row, clears cookie, returns 204
 * AC-4.2  : second logout (no cookie) → idempotent 204
 * AC-4.3  : auth-service revoke failure → BFF still completes logout (UX hardening)
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { type Request, type Response } from 'express';
import { createLogger } from '@railrepay/winston-logger';
import type { Redis } from 'ioredis';
import { revokeSession } from '../lib/auth-service-client.js';
import { getSession, sessionRedisKey } from '../lib/session-store.js';

const logger = createLogger({
  serviceName: process.env.SERVICE_NAME ?? 'web-app-bff',
  level: process.env.LOG_LEVEL ?? 'info',
  environment: process.env.NODE_ENV ?? 'development',
});

/**
 * POST /api/auth/logout handler factory.
 * Accepts redis for session lookup and deletion.
 */
export function createLogoutHandler(redis: Pick<Redis, 'get' | 'expire' | 'del'>) {
  return async function handleLogout(req: Request, res: Response): Promise<void> {
    const cookieName = process.env.SESSION_COOKIE_NAME ?? 'rr_session';
    const cookies = req.cookies as Record<string, string | undefined>;
    const sid = cookies[cookieName];

    // Helper: clear cookie and return 204
    const clearCookieAndRespond = () => {
      res.cookie(cookieName, '', {
        maxAge: 0,
        path: '/',
        httpOnly: true,
      });
      res.status(204).end();
    };

    // AC-4.2: No cookie — idempotent 204
    if (!sid) {
      logger.info('handleLogout: no session cookie — idempotent 204', {
        component: 'web-app-bff/logout-handler',
      });
      clearCookieAndRespond();
      return;
    }

    // Look up the Redis session to get the access_token for revoke
    const session = await getSession(redis as Pick<Redis, 'get' | 'expire'>, sid);

    if (!session) {
      // Stale cookie — no Redis row; still clear and return 204
      logger.warn('handleLogout: session not found in Redis — clearing cookie', {
        component: 'web-app-bff/logout-handler',
      });
      clearCookieAndRespond();
      return;
    }

    // AC-4.1(a): best-effort auth-service revoke (failure tolerance per AC-4.3)
    await revokeSession(session.access_token);

    // AC-4.1(b): delete Redis row
    await redis.del(sessionRedisKey(sid));

    logger.info('handleLogout: session deleted from Redis', {
      component: 'web-app-bff/logout-handler',
    });

    // AC-4.1(c): clear cookie and return 204
    clearCookieAndRespond();
  };
}
