/**
 * Journey-matcher HTTP client for web-app-bff
 *
 * Provides matchJourney helper for POST /journeys/match.
 * All outbound calls use Node http/https modules (not fetch) so that nock can
 * intercept in tests (mirrors auth-service-client pattern).
 * Wrapped in a 5 s AbortController timeout.
 *
 * Story   : RAILREPAY-WEB-BFF-005
 * AC-9    : 503/timeout from journey-matcher → client returns { statusCode: 503, ... }
 * AC-13   : X-Correlation-ID header forwarded on every outbound call
 *
 * Mocked HTTP endpoint (tests):
 *   POST {JOURNEY_MATCHER_URL}/journeys/match
 *   Verified real: services/journey-matcher/src/api/match-journey.handler.ts
 *   Exposed at: services/journey-matcher/src/index.ts app.use('/journeys', ...)
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

/** Outbound HTTP timeout — 5 s (locked in WEB-BFF-005 spec) */
export const JOURNEY_MATCHER_TIMEOUT_MS = 5000;

const logger = createLogger({
  serviceName: process.env.SERVICE_NAME ?? 'web-app-bff',
  level: process.env.LOG_LEVEL ?? 'info',
  environment: process.env.NODE_ENV ?? 'development',
});

/**
 * Minimal HTTP POST helper using Node's built-in http/https modules.
 * Uses http/https (not native fetch) so that nock can intercept in tests.
 */
function httpPost<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<{ statusCode: number; body: T }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    const payload = body !== null && body !== undefined ? JSON.stringify(body) : '';

    const reqHeaders: Record<string, string> = {
      ...headers,
      'Content-Length': String(Buffer.byteLength(payload)),
    };

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: reqHeaders,
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

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * Wrap a promise with an AbortController-based timeout.
 */
function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number = JOURNEY_MATCHER_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fn(controller.signal).finally(() => clearTimeout(timer));
}

/** Input shape forwarded to journey-matcher POST /journeys/match */
export interface MatchJourneyInput {
  user_id: string;
  origin_station: string;
  destination_station: string;
  departure_date: string;
  departure_time: string;
  journey_type?: string;
  scan_id?: string;
  // JM-002: Anytime/Any-Permitted ticket attestation fields (AC-7)
  ticket_type?: string;
  actual_departure_time?: string;
  actual_rid?: string;
  // BL-336 SS3: per-leg attestation fields
  onward_plan?: boolean;
  intended_legs?: Array<{ segment_order: number; rid: string }>;
}

/**
 * Call POST /journeys/match on journey-matcher service.
 * Returns { statusCode, body } for the handler to interpret.
 * Wrapped with 5 s AbortController timeout (AC-9).
 *
 * @param input         Journey match input (user_id + journey details)
 * @param correlationId X-Correlation-ID to forward (AC-13)
 */
export async function matchJourney(
  input: MatchJourneyInput,
  correlationId?: string
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const journeyMatcherUrl = process.env.JOURNEY_MATCHER_URL ?? '';
  const url = `${journeyMatcherUrl}/journeys/match`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (correlationId) {
    headers['x-correlation-id'] = correlationId;
  }

  logger.info('matchJourney: calling journey-matcher', {
    component: 'web-app-bff/journey-matcher-client',
  });

  try {
    const { statusCode, body } = await withTimeout<{ statusCode: number; body: Record<string, unknown> }>(
      (signal) =>
        httpPost<Record<string, unknown>>(
          url,
          input,
          headers,
          signal
        ),
      JOURNEY_MATCHER_TIMEOUT_MS
    );
    return { statusCode, body };
  } catch (err) {
    logger.warn('matchJourney: request failed or timed out', {
      component: 'web-app-bff/journey-matcher-client',
      error: err instanceof Error ? err.message : String(err),
    });
    return { statusCode: 503, body: { error: 'upstream_unavailable' } };
  }
}
