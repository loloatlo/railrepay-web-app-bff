/**
 * Handler: GET /api/tickets/:scanId
 *
 * Validates auth, UUID format, and scan ownership via Redis before
 * proxying to the OCR service for results.
 *
 * Story   : RAILREPAY-WEB-BFF-004
 * AC-8    : 401 when no session
 * AC-9    : scanId must match UUID-v4 regex; malformed → 400 { error: 'invalid scan_id format' }
 * AC-10   : On valid scanId + ocr 200 → 200 with verbatim ocr result fields
 * AC-11   : User scoping — BFF checks bff:scan:<scanId> in Redis;
 *           absent OR value !== req.session.user_id → 403 { error: 'forbidden' }
 * AC-12   : OCR 404 → 404 { error: 'scan not found' }
 * AC-13   : OCR 5xx → 503 { error: 'ocr_unavailable' }
 *           Unexpected OCR 4xx → 502 { error: 'ocr_error', upstream_status: <n> }
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { type Request, type Response } from 'express';
import { createLogger } from '@railrepay/winston-logger';
import type { Redis } from 'ioredis';
import type { RequestSession } from '../middleware/cookie-session.js';
import { getScanResult } from '../lib/ocr-service-client.js';
import { getScanOwner } from '../lib/scan-ownership-store.js';

const logger = createLogger({
  serviceName: process.env.SERVICE_NAME ?? 'web-app-bff',
  level: process.env.LOG_LEVEL ?? 'info',
  environment: process.env.NODE_ENV ?? 'development',
});

/** UUID v4 regex (AC-9) */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Create the get-ticket-scan handler, injecting redis.
 *
 * @param redis - ioredis client for scan ownership reads
 * @returns Express request handler
 */
export function createGetTicketScanHandler(
  redis: Pick<Redis, 'get'>
) {
  return async function getTicketScanHandler(req: Request, res: Response): Promise<void> {
    const session = (req as Request & { session?: RequestSession }).session;

    // AC-8: Auth check
    if (!session) {
      logger.debug('getTicketScanHandler: no session — returning 401', {
        component: 'web-app-bff/get-ticket-scan-handler',
      });
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const { scanId } = req.params;

    // AC-9: Validate UUID v4 format
    if (!UUID_V4_REGEX.test(scanId)) {
      logger.debug('getTicketScanHandler: invalid scan_id format', {
        component: 'web-app-bff/get-ticket-scan-handler',
      });
      res.status(400).json({ error: 'invalid scan_id format' });
      return;
    }

    // AC-11: User scoping — check Redis ownership
    const ownerUserId = await getScanOwner(redis, scanId);

    if (ownerUserId === null || ownerUserId !== session.user_id) {
      logger.warn('getTicketScanHandler: scan ownership mismatch or absent — returning 403', {
        component: 'web-app-bff/get-ticket-scan-handler',
      });
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const correlationId = (req.headers['x-correlation-id'] as string | undefined)
      ?? `bff-${Date.now()}`;

    try {
      const { statusCode, body } = await getScanResult({
        scanId,
        correlationId,
      });

      // AC-12: OCR 404 → 404
      if (statusCode === 404) {
        logger.debug('getTicketScanHandler: scan not found in ocr-service', {
          component: 'web-app-bff/get-ticket-scan-handler',
        });
        res.status(404).json({ error: 'scan not found' });
        return;
      }

      // AC-13: OCR 5xx → 503
      if (statusCode >= 500) {
        logger.warn('getTicketScanHandler: ocr-service returned 5xx', {
          component: 'web-app-bff/get-ticket-scan-handler',
          statusCode,
        });
        res.status(503).json({ error: 'ocr_unavailable' });
        return;
      }

      // AC-13: Unexpected 4xx → 502
      if (statusCode >= 400) {
        logger.warn('getTicketScanHandler: ocr-service returned unexpected 4xx', {
          component: 'web-app-bff/get-ticket-scan-handler',
          statusCode,
        });
        res.status(502).json({ error: 'ocr_error', upstream_status: statusCode });
        return;
      }

      // AC-10: Success — return verbatim OCR response
      logger.info('getTicketScanHandler: scan result retrieved', {
        component: 'web-app-bff/get-ticket-scan-handler',
      });

      res.status(200).json(body);
    } catch (err) {
      logger.warn('getTicketScanHandler: ocr-service call failed', {
        component: 'web-app-bff/get-ticket-scan-handler',
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(503).json({ error: 'ocr_unavailable' });
    }
  };
}
