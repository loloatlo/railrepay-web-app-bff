/**
 * Journeys router for web-app-bff
 *
 * Mounts:
 *   POST /api/journeys/check-delay — check-delay.handler (composite 3-service chain)
 *
 * Requires cookie-session + bearer-fallback middleware to be mounted upstream
 * so that req.session is populated before handler is reached.
 *
 * Story   : RAILREPAY-WEB-BFF-005
 * AC-1    : Body validation delegated to handler
 * AC-2    : Auth check delegated to handler (reads req.session)
 * AC-3..12: All orchestration logic in handler
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { Router } from 'express';
import type { Redis } from 'ioredis';
import { createCheckDelayHandler } from '../handlers/check-delay.handler.js';

/**
 * Create the journeys router.
 *
 * The `redis` parameter is accepted for symmetry with other routers and to
 * allow future endpoints to use Redis directly. The check-delay handler does
 * not use Redis directly — session is read from req.session (populated by
 * upstream middleware).
 *
 * @param _redis - ioredis client (reserved for future use)
 * @returns Express Router
 */
export function createJourneysRouter(_redis: Pick<Redis, 'get' | 'set'>): Router {
  const router = Router();

  // POST /api/journeys/check-delay
  // Auth enforced inside handler (reads req.session populated by upstream middleware)
  router.post('/api/journeys/check-delay', createCheckDelayHandler());

  return router;
}
