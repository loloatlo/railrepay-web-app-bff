/**
 * Correlation ID middleware for web-app-bff
 *
 * Extracts X-Correlation-ID from incoming request headers.
 * Generates a UUID v4 if the header is absent.
 * Sets the correlation ID on the response header.
 * Attaches correlation ID to logger context for structured logging.
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getLogger } from '../lib/logger.js';

/**
 * Creates the correlation ID middleware.
 *
 * @returns Express RequestHandler middleware
 */
export function createCorrelationIdMiddleware(): RequestHandler {
  const logger = getLogger();

  return function correlationIdMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    // Extract from header or generate a new UUID v4
    const correlationId =
      (req.headers['x-correlation-id'] as string | undefined) ?? uuidv4();

    // Echo back in response header
    res.setHeader('X-Correlation-ID', correlationId);

    // Log the incoming request with correlation ID
    logger.info(`${req.method} ${req.path}`, {
      component: 'web-app-bff/http',
      method: req.method,
      path: req.path,
      correlationId,
    });

    next();
  };
}
