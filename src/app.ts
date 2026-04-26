/**
 * Express application factory for web-app-bff
 *
 * createApp(redis) creates the Express app, mounts middleware and routes,
 * and returns it WITHOUT calling .listen() — enabling testability.
 *
 * AUTH_SERVICE_URL is read from process.env at createApp() call time so that
 * integration tests can set it before invoking createApp().
 *
 * ADR references:
 *   ADR-008 — Health check endpoint
 *   ADR-014 — TDD / testable app factory pattern
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { type Redis } from 'ioredis';
import { createHealthRouter } from './routes/health.js';
import { createMetricsRouter } from './routes/metrics.js';
import { createSessionIssueRouter, createProtectedSessionRouter } from './routes/session.js';
import { createAuthPreAuthRouter, createAuthProtectedRouter } from './routes/auth.js';
import { createCorsMiddleware } from './middleware/cors.js';
import { createCorrelationIdMiddleware } from './middleware/correlation-id.js';
import { createRequireSameOriginMiddleware } from './middleware/require-same-origin.js';
import { createCookieSessionMiddleware } from './middleware/cookie-session.js';
import { createBearerFallbackMiddleware } from './middleware/bearer-fallback.js';

/**
 * Create and configure the web-app-bff Express application.
 *
 * Reads AUTH_SERVICE_URL directly from process.env so that integration tests
 * can inject it at createApp() call time (per AC-4 DI pattern).
 *
 * @param redis - ioredis client (injected for testability)
 * @returns Configured Express application (not yet listening)
 */
export function createApp(redis: Pick<Redis, 'ping' | 'get' | 'expire' | 'set' | 'del'>): Express {
  const app = express();

  // Trust proxy headers — required for Railway/proxy environments (ADR note)
  app.set('trust proxy', true);

  // Standard body parsing
  app.use(express.json());

  // CORS middleware — reads ALLOWED_ORIGINS from process.env
  app.use(createCorsMiddleware());

  // Cookie parser — must be mounted before session middleware
  app.use(cookieParser());

  // Correlation ID middleware (ADR-002)
  app.use(createCorrelationIdMiddleware());

  // CSRF origin check — blocks state-changing requests from unlisted origins
  app.use(createRequireSameOriginMiddleware());

  // Health check and metrics: mounted BEFORE auth middleware so they remain
  // accessible without a session (ADR-008)
  const authServiceUrl = process.env.AUTH_SERVICE_URL ?? '';
  app.use('/health', createHealthRouter(redis, { authServiceUrl }));
  app.use('/metrics', createMetricsRouter());

  // POST /api/session/issue — public endpoint (no auth required)
  // Mounted BEFORE the auth middleware chain so the bearer-fallback doesn't block it.
  app.use(createSessionIssueRouter(redis));

  // Pre-auth /api/auth/* routes: POST /api/auth/otp/start, POST /api/auth/otp/verify
  // Mounted BEFORE session middleware (no session required for OTP flows)
  app.use(createAuthPreAuthRouter(redis));

  // Session authentication middleware chain:
  //   1. Cookie-session: populates req.session from rr_session cookie
  //   2. Bearer-fallback: populates req.session from Authorization: Bearer JWT
  //      (skipped if rr_session cookie is present)
  app.use(createCookieSessionMiddleware(redis));
  app.use(createBearerFallbackMiddleware());

  // Protected session routes: GET /api/session, POST /api/session/refresh
  app.use(createProtectedSessionRouter(redis));

  // Protected /api/auth/* routes: GET /api/auth/me, POST /api/auth/logout
  // Mounted AFTER session middleware so req.session is populated
  app.use(createAuthProtectedRouter(redis));

  return app;
}
