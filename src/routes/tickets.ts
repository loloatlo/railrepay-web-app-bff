/**
 * Tickets router for web-app-bff
 *
 * Mounts:
 *   POST /api/tickets/upload  — upload-ticket.handler
 *   GET  /api/tickets/:scanId — get-ticket-scan.handler
 *
 * Both endpoints require authentication (populated by upstream
 * cookie-session + bearer-fallback middleware).
 *
 * Story   : RAILREPAY-WEB-BFF-004
 * AC-1    : POST /api/tickets/upload — 401 when unauthenticated
 * AC-2    : POST → 200 { scan_id } on success
 * AC-8    : GET /api/tickets/:scanId — 401 when unauthenticated
 * AC-10   : GET → 200 with verbatim ocr result fields
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { Router } from 'express';
import type { Redis } from 'ioredis';
import { createLogger } from '@railrepay/winston-logger';
import { createUploadTicketHandler } from '../handlers/upload-ticket.handler.js';
import { createGetTicketScanHandler } from '../handlers/get-ticket-scan.handler.js';

const logger = createLogger({
  serviceName: process.env.SERVICE_NAME ?? 'web-app-bff',
  level: process.env.LOG_LEVEL ?? 'info',
  environment: process.env.NODE_ENV ?? 'development',
});

type TicketsRedis = Pick<Redis, 'get' | 'set'>;

/**
 * Create the tickets router.
 * Must be mounted AFTER cookie-session + bearer-fallback middleware.
 *
 * @param redis - ioredis client injected for testability
 * @returns Express Router with upload and scan-result routes
 */
export function createTicketsRouter(redis: TicketsRedis): Router {
  const router = Router();

  const uploadHandler = createUploadTicketHandler(redis);
  const getHandler = createGetTicketScanHandler(redis);

  router.post('/api/tickets/upload', (req, res) => {
    logger.debug('createTicketsRouter: POST /api/tickets/upload', {
      component: 'web-app-bff/tickets-routes',
    });
    void uploadHandler(req, res);
  });

  router.get('/api/tickets/:scanId', (req, res) => {
    logger.debug('createTicketsRouter: GET /api/tickets/:scanId', {
      component: 'web-app-bff/tickets-routes',
    });
    void getHandler(req, res);
  });

  return router;
}
