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
import { type Redis } from 'ioredis';
import { createHealthRouter } from './routes/health.js';
import { createMetricsRouter } from './routes/metrics.js';
import { createCorsMiddleware } from './middleware/cors.js';
import { createCorrelationIdMiddleware } from './middleware/correlation-id.js';

/**
 * Create and configure the web-app-bff Express application.
 *
 * Reads AUTH_SERVICE_URL directly from process.env so that integration tests
 * can inject it at createApp() call time (per AC-4 DI pattern).
 *
 * @param redis - ioredis client (injected for testability)
 * @returns Configured Express application (not yet listening)
 */
export function createApp(redis: Pick<Redis, 'ping'>): Express {
  const app = express();

  // Trust proxy headers — required for Railway/proxy environments (ADR note)
  app.set('trust proxy', true);

  // Standard body parsing
  app.use(express.json());

  // CORS middleware — reads ALLOWED_ORIGINS from process.env
  app.use(createCorsMiddleware());

  // Correlation ID middleware (ADR-002)
  app.use(createCorrelationIdMiddleware());

  // Read AUTH_SERVICE_URL at createApp() time so integration tests can
  // set it before calling createApp().
  const authServiceUrl = process.env.AUTH_SERVICE_URL ?? '';

  // Health check route (ADR-008)
  app.use('/health', createHealthRouter(redis, { authServiceUrl }));

  // Metrics route (ADR-006)
  app.use('/metrics', createMetricsRouter());

  return app;
}
