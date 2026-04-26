/**
 * Auth routes for web-app-bff — WEB-BFF-003
 *
 * Exports individual router factories (for focused unit tests) and a
 * combined createAuthRouter (for integration tests and app wiring).
 *
 * Route layout:
 *   POST /api/auth/otp/start   — pre-auth (no session required)
 *   POST /api/auth/otp/verify  — pre-auth (no session required)
 *   GET  /api/auth/me          — protected (requires req.session from middleware)
 *   POST /api/auth/logout      — protected (reads cookie directly; tolerates missing session)
 *
 * Story   : RAILREPAY-WEB-BFF-003
 * AC-1.x  : OTP start route
 * AC-2.x  : OTP verify route
 * AC-3.x  : /me route
 * AC-4.x  : logout route
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { Router } from 'express';
import type { Redis } from 'ioredis';
import { createLogger } from '@railrepay/winston-logger';
import { handleOtpStart } from '../handlers/otp-start.handler.js';
import { createOtpVerifyHandler } from '../handlers/otp-verify.handler.js';
import { handleMe } from '../handlers/me.handler.js';
import { createLogoutHandler } from '../handlers/logout.handler.js';

const logger = createLogger({
  serviceName: process.env.SERVICE_NAME ?? 'web-app-bff',
  level: process.env.LOG_LEVEL ?? 'info',
  environment: process.env.NODE_ENV ?? 'development',
});

type AuthRedis = Pick<Redis, 'get' | 'expire' | 'set' | 'del'>;

/**
 * Router factory for POST /api/auth/otp/start only.
 * Used by unit tests that test this endpoint in isolation.
 */
export function createOtpStartRouter(_redis: AuthRedis): Router {
  const router = Router();

  router.post('/api/auth/otp/start', (req, res) => {
    logger.debug('createOtpStartRouter: POST /api/auth/otp/start', {
      component: 'web-app-bff/auth-routes',
    });
    void handleOtpStart(req, res);
  });

  return router;
}

/**
 * Router factory for POST /api/auth/otp/verify only.
 * Used by unit tests that test this endpoint in isolation.
 */
export function createOtpVerifyRouter(redis: AuthRedis): Router {
  const router = Router();
  const handler = createOtpVerifyHandler(redis);

  router.post('/api/auth/otp/verify', (req, res) => {
    logger.debug('createOtpVerifyRouter: POST /api/auth/otp/verify', {
      component: 'web-app-bff/auth-routes',
    });
    void handler(req, res);
  });

  return router;
}

/**
 * Router factory for GET /api/auth/me only.
 * Used by unit tests that test this endpoint in isolation.
 * NOTE: Must be mounted AFTER cookie-session + bearer-fallback middleware.
 */
export function createMeRouter(_redis: AuthRedis): Router {
  const router = Router();

  router.get('/api/auth/me', (req, res) => {
    logger.debug('createMeRouter: GET /api/auth/me', {
      component: 'web-app-bff/auth-routes',
    });
    void handleMe(req, res);
  });

  return router;
}

/**
 * Router factory for POST /api/auth/logout only.
 * Used by unit tests that test this endpoint in isolation.
 * NOTE: Reads rr_session cookie directly (does not depend on req.session).
 */
export function createLogoutRouter(redis: AuthRedis): Router {
  const router = Router();
  const handler = createLogoutHandler(redis);

  router.post('/api/auth/logout', (req, res) => {
    logger.debug('createLogoutRouter: POST /api/auth/logout', {
      component: 'web-app-bff/auth-routes',
    });
    void handler(req, res);
  });

  return router;
}

/**
 * Combined auth router — all four /api/auth/* endpoints.
 * Used by integration tests and app.ts wiring.
 *
 * NOTE: /me and /logout require req.session to be populated by upstream
 * middleware (cookie-session + bearer-fallback). Mount this router AFTER
 * those middleware.
 *
 * /start and /verify are pre-auth and do not require a session.
 */
export function createAuthRouter(redis: AuthRedis): Router {
  const router = Router();

  // Pre-auth routes
  router.post('/api/auth/otp/start', (req, res) => {
    void handleOtpStart(req, res);
  });

  router.post('/api/auth/otp/verify', (req, res) => {
    void createOtpVerifyHandler(redis)(req, res);
  });

  // Protected routes (rely on req.session from upstream middleware)
  router.get('/api/auth/me', (req, res) => {
    void handleMe(req, res);
  });

  router.post('/api/auth/logout', (req, res) => {
    void createLogoutHandler(redis)(req, res);
  });

  return router;
}

/**
 * Pre-auth router: POST /api/auth/otp/start + POST /api/auth/otp/verify.
 * For use in app.ts — mounted BEFORE session middleware.
 */
export function createAuthPreAuthRouter(redis: AuthRedis): Router {
  const router = Router();

  router.post('/api/auth/otp/start', (req, res) => {
    void handleOtpStart(req, res);
  });

  router.post('/api/auth/otp/verify', (req, res) => {
    void createOtpVerifyHandler(redis)(req, res);
  });

  return router;
}

/**
 * Protected router: GET /api/auth/me + POST /api/auth/logout.
 * For use in app.ts — mounted AFTER session middleware.
 */
export function createAuthProtectedRouter(redis: AuthRedis): Router {
  const router = Router();

  router.get('/api/auth/me', (req, res) => {
    void handleMe(req, res);
  });

  router.post('/api/auth/logout', (req, res) => {
    void createLogoutHandler(redis)(req, res);
  });

  return router;
}
