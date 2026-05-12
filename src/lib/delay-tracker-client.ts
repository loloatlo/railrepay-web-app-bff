/**
 * Delay-tracker HTTP client for web-app-bff
 *
 * Provides queryDelay helper for GET /delays/:journey_id?user_id=<uuid>.
 * All outbound calls use Node http/https modules (not fetch) so that nock can
 * intercept in tests (mirrors auth-service-client pattern).
 * Wrapped in a 2 s AbortController timeout.
 *
 * Story   : RAILREPAY-WEB-BFF-005
 * AC-10   : 503/timeout from delay-tracker → client returns { statusCode: 503, ... }
 * AC-13   : X-Correlation-ID header forwarded on every outbound call
 *
 * Mocked HTTP endpoint (tests):
 *   GET {DELAY_TRACKER_URL}/delays/:journey_id?user_id=<uuid>
 *   Verified real: services/delay-tracker/src/api/delay-query.handler.ts DelayQueryHandler
 *   Exposed at: services/delay-tracker/src/index.ts delayQueryHandler.register(app)
 *   Last verified: 2026-05-12 (Jessie WEB-BFF-005 US-2)
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import http from 'node:http';
import https from 'node:https';
import { createLogger } from '@railrepay/winston-logger';

/** Outbound HTTP timeout — 2 s (locked in WEB-BFF-005 spec) */
export const DELAY_TRACKER_TIMEOUT_MS = 2000;

const logger = createLogger({
  serviceName: process.env.SERVICE_NAME ?? 'web-app-bff',
  level: process.env.LOG_LEVEL ?? 'info',
  environment: process.env.NODE_ENV ?? 'development',
});

/**
 * Minimal HTTP GET helper using Node's built-in http/https modules.
 * Uses http/https (not native fetch) so that nock can intercept in tests.
 */
function httpGet<T>(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<{ statusCode: number; body: T }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers,
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          const parsed = data ? (JSON.parse(data) as T) : ({} as T);
          resolve({ statusCode: res.statusCode ?? 0, body: parsed });
        } catch {
          resolve({ statusCode: res.statusCode ?? 0, body: {} as T });
        }
      });
    });

    req.on('error', reject);

    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('AbortError'));
        return;
      }
      signal.addEventListener('abort', () => {
        req.destroy(new Error('AbortError'));
      });
    }

    req.end();
  });
}

/**
 * Wrap a promise with an AbortController-based timeout.
 */
function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number = DELAY_TRACKER_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fn(controller.signal).finally(() => clearTimeout(timer));
}

/**
 * Call GET /delays/:journey_id?user_id=<uuid> on delay-tracker service.
 * Returns { statusCode, body } for the handler to interpret.
 * Wrapped with 2 s AbortController timeout (AC-10).
 *
 * @param journeyId     Journey UUID to query
 * @param userId        User UUID (appended as query param; from session)
 * @param correlationId X-Correlation-ID to forward (AC-13)
 */
export async function queryDelay(
  journeyId: string,
  userId: string,
  correlationId?: string
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const delayTrackerUrl = process.env.DELAY_TRACKER_URL ?? '';
  const url = `${delayTrackerUrl}/delays/${journeyId}?user_id=${encodeURIComponent(userId)}`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (correlationId) {
    headers['x-correlation-id'] = correlationId;
  }

  logger.info('queryDelay: calling delay-tracker', {
    component: 'web-app-bff/delay-tracker-client',
  });

  try {
    const { statusCode, body } = await withTimeout<{ statusCode: number; body: Record<string, unknown> }>(
      (signal) =>
        httpGet<Record<string, unknown>>(
          url,
          headers,
          signal
        ),
      DELAY_TRACKER_TIMEOUT_MS
    );
    return { statusCode, body };
  } catch (err) {
    logger.warn('queryDelay: request failed or timed out', {
      component: 'web-app-bff/delay-tracker-client',
      error: err instanceof Error ? err.message : String(err),
    });
    return { statusCode: 503, body: { error: 'upstream_unavailable' } };
  }
}
