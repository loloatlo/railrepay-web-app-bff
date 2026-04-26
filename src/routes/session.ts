/**
 * Session routes for web-app-bff
 *
 * Exports:
 *   createSessionRouter(redis) — Router with GET /api/session, POST /api/session/refresh,
 *                                POST /api/session/issue
 *   createSessionIssueRouter(redis) — Router with only POST /api/session/issue (no auth required)
 *   createProtectedSessionRouter(redis) — Router with GET /api/session, POST /api/session/refresh
 *
 * Authentication strategy: reads rr_session cookie and calls getSession from Redis
 * directly (does not depend on prior middleware populating req.session). This keeps
 * the routes testable in isolation.
 *
 * Story   : RAILREPAY-WEB-BFF-002
 * AC-3    : createSession returns {sessionId, expiresAt}; cookie set with HttpOnly, Secure, SameSite=Lax
 * AC-4    : GET /api/session → 200 {user_id, expires_at}; 401 + cookie-clear when absent
 * AC-5    : POST /api/session/refresh → 204; 401 + cookie-clear when unauthenticated
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { Router, type Request, type Response } from 'express';
import { createLogger } from '@railrepay/winston-logger';
import type { Redis } from 'ioredis';
import { getSession, createSession, SESSION_TTL_SECONDS } from '../lib/session-store.js';

const logger = createLogger({
  serviceName: process.env.SERVICE_NAME ?? 'web-app-bff',
  level: process.env.LOG_LEVEL ?? 'info',
  environment: process.env.NODE_ENV ?? 'development',
});

type SessionRedis = Pick<Redis, 'get' | 'expire' | 'set'>;

/**
 * Resolve the session from the rr_session cookie.
 * Returns the session data or null.
 * On stale cookie: clears the cookie and sends 401 set-cookie header.
 */
async function resolveSession(req: Request, res: Response, redis: SessionRedis) {
  const cookieName = process.env.SESSION_COOKIE_NAME ?? 'rr_session';
  const cookies = req.cookies as Record<string, string | undefined>;
  const sid = cookies[cookieName];

  if (!sid) {
    return null;
  }

  const session = await getSession(redis, sid);

  if (!session) {
    // Stale/expired cookie — clear it with Max-Age=0
    res.cookie(cookieName, '', { maxAge: 0, path: '/', httpOnly: true });
    return null;
  }

  return session;
}

/**
 * Build the issue-only session router (no authentication required).
 * POST /api/session/issue — internal: creates Redis session + sets rr_session cookie
 *
 * @param redis - ioredis client injected for testability
 * @returns Express Router
 */
export function createSessionIssueRouter(redis: SessionRedis): Router {
  const router = Router();

  router.post('/api/session/issue', async (req: Request, res: Response): Promise<void> => {
    const { user_id, access_token } = req.body as { user_id?: string; access_token?: string };

    if (!user_id || !access_token) {
      res.status(400).json({ error: 'bad_request', message: 'user_id and access_token are required' });
      return;
    }

    const { sessionId, expiresAt } = await createSession(redis, { user_id, access_token });

    const cookieName = process.env.SESSION_COOKIE_NAME ?? 'rr_session';
    const cookieSecure = process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'development';

    res.cookie(cookieName, sessionId, {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS * 1000,
      expires: expiresAt,
    });

    logger.info('POST /api/session/issue: session created and cookie set', {
      component: 'web-app-bff/session-route',
    });

    res.status(204).end();
  });

  return router;
}

/**
 * Build the protected session router (authentication required via cookie).
 * GET  /api/session          — returns {user_id, expires_at}
 * POST /api/session/refresh  — slides Redis TTL; returns 204
 *
 * @param redis - ioredis client injected for testability
 * @returns Express Router
 */
export function createProtectedSessionRouter(redis: SessionRedis): Router {
  const router = Router();

  router.get('/api/session', async (req: Request, res: Response): Promise<void> => {
    const session = await resolveSession(req, res, redis);

    if (!session) {
      res.status(401).json({ error: 'unauthorized', message: 'No valid session' });
      return;
    }

    logger.info('GET /api/session: returning session info', {
      component: 'web-app-bff/session-route',
    });

    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();

    res.status(200).json({
      user_id: session.user_id,
      expires_at: expiresAt,
    });
  });

  router.post('/api/session/refresh', async (req: Request, res: Response): Promise<void> => {
    const session = await resolveSession(req, res, redis);

    if (!session) {
      res.status(401).json({ error: 'unauthorized', message: 'No valid session' });
      return;
    }

    logger.info('POST /api/session/refresh: session TTL slid', {
      component: 'web-app-bff/session-route',
    });

    res.status(204).end();
  });

  return router;
}

/**
 * Build the full session router (all three endpoints).
 * Used by unit tests that test routes in isolation.
 *
 * @param redis - ioredis client injected for testability
 * @returns Express Router with all session endpoints
 */
export function createSessionRouter(redis: SessionRedis): Router {
  const router = Router();

  // Mount both public and protected routes
  router.use(createSessionIssueRouter(redis));
  router.use(createProtectedSessionRouter(redis));

  return router;
}
