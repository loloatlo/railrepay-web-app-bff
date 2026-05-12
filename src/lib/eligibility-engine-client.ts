/**
 * Eligibility-engine HTTP client for web-app-bff
 *
 * Provides getEligibility helper for GET /eligibility/:journey_id.
 * All outbound calls use Node http/https modules (not fetch) so that nock can
 * intercept in tests (mirrors auth-service-client pattern).
 * Wrapped in a 2 s AbortController timeout.
 *
 * Story   : RAILREPAY-WEB-BFF-005
 * AC-11   : 503/timeout from eligibility-engine → client returns { statusCode: 503, ... }
 * AC-13   : X-Correlation-ID header forwarded on every outbound call
 *
 * Mocked HTTP endpoint (tests):
 *   GET {ELIGIBILITY_ENGINE_URL}/eligibility/:journey_id
 *   Verified real: services/eligibility-engine/src/app.ts
 *     app.get('/eligibility/:journey_id', ...)
 *   Exposed at: services/eligibility-engine/src/index.ts via createApp()
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
export const ELIGIBILITY_ENGINE_TIMEOUT_MS = 2000;

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
  ms: number = ELIGIBILITY_ENGINE_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fn(controller.signal).finally(() => clearTimeout(timer));
}

/**
 * Call GET /eligibility/:journey_id on eligibility-engine service.
 * Read-only endpoint — DO NOT call POST /eligibility/evaluate.
 * Returns { statusCode, body } for the handler to interpret.
 * Wrapped with 2 s AbortController timeout (AC-11).
 *
 * @param journeyId     Journey UUID to look up
 * @param correlationId X-Correlation-ID to forward (AC-13)
 */
export async function getEligibility(
  journeyId: string,
  correlationId?: string
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const eligibilityEngineUrl = process.env.ELIGIBILITY_ENGINE_URL ?? '';
  const url = `${eligibilityEngineUrl}/eligibility/${journeyId}`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (correlationId) {
    headers['x-correlation-id'] = correlationId;
  }

  logger.info('getEligibility: calling eligibility-engine', {
    component: 'web-app-bff/eligibility-engine-client',
  });

  try {
    const { statusCode, body } = await withTimeout<{ statusCode: number; body: Record<string, unknown> }>(
      (signal) =>
        httpGet<Record<string, unknown>>(
          url,
          headers,
          signal
        ),
      ELIGIBILITY_ENGINE_TIMEOUT_MS
    );
    return { statusCode, body };
  } catch (err) {
    logger.warn('getEligibility: request failed or timed out', {
      component: 'web-app-bff/eligibility-engine-client',
      error: err instanceof Error ? err.message : String(err),
    });
    return { statusCode: 503, body: { error: 'upstream_unavailable' } };
  }
}
