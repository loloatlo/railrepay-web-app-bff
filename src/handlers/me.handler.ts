/**
 * Handler: GET /api/auth/me
 *
 * Reads req.session populated by cookie-session or bearer-fallback middleware.
 * Returns 200 { user_id, session_id } if session present; 401 { error: 'unauthorized' } if absent.
 * NO auth-service round-trip (human-locked decision OQ-B).
 *
 * Story   : RAILREPAY-WEB-BFF-003
 * AC-3.1  : valid rr_session cookie → 200 { user_id, session_id } from req.session
 * AC-3.2  : no cookie and no Bearer → 401 { error: 'unauthorized' }
 * AC-3.3  : valid Bearer JWT (no cookie) → 200 { user_id, session_id } from JWT claims
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { type Request, type Response } from 'express';
import { createLogger } from '@railrepay/winston-logger';
import type { RequestSession } from '../middleware/cookie-session.js';

const logger = createLogger({
  serviceName: process.env.SERVICE_NAME ?? 'web-app-bff',
  level: process.env.LOG_LEVEL ?? 'info',
  environment: process.env.NODE_ENV ?? 'development',
});

/**
 * GET /api/auth/me handler.
 *
 * Relies on req.session being populated by upstream middleware
 * (cookie-session or bearer-fallback). The route MUST be mounted
 * AFTER those middleware.
 */
export async function handleMe(req: Request, res: Response): Promise<void> {
  const session = (req as Request & { session?: RequestSession }).session;

  if (!session) {
    logger.debug('handleMe: no session — returning 401', {
      component: 'web-app-bff/me-handler',
    });
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  logger.debug('handleMe: returning session info', {
    component: 'web-app-bff/me-handler',
    source: session.source,
  });

  res.status(200).json({
    user_id: session.user_id,
    session_id: session.session_id,
  });
}
