/**
 * Evaluation-coordinator HTTP client for web-app-bff
 *
 * Provides triggerEvaluation helper for POST /evaluate/:journeyId.
 * All outbound calls use Node http/https modules (not fetch) so that nock can
 * intercept in tests (mirrors eligibility-engine-client pattern).
 * Wrapped in a 5 s AbortController timeout (fire-and-forget, non-fatal).
 *
 * Bug Fix : BL-308 — on-demand check-delay never triggers eligibility evaluation
 * AC-1    : POST {EVALUATION_COORDINATOR_URL}/evaluate/:journeyId
 * AC-2    : 5xx → throw (handler catch absorbs non-fatally)
 * AC-3    : 422 dedup → resolve (non-fatal)
 * AC-4    : Missing EVALUATION_COORDINATOR_URL → warn + return (no throw, no HTTP call)
 * AC-5    : X-Correlation-ID forwarded on every outbound call (mirrors AC-13 on EE client)
 *
 * Mocked HTTP endpoint (tests):
 *   POST {EVALUATION_COORDINATOR_URL}/evaluate/:journeyId
 *   Verified real: services/evaluation-coordinator — ADR-028 Option A
 *   Blake T1 confirmed 202/422 at that path (2026-05-28)
 *
 * Pattern mirrors: services/web-app-bff/src/lib/eligibility-engine-client.ts
 * (node http/https, AbortController, same logger instance pattern)
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-028 — On-demand evaluation trigger via evaluation-coordinator
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import http from 'node:http';
import https from 'node:https';
import { createLogger } from '@railrepay/winston-logger';

/** Outbound HTTP timeout — 5 s (fire-and-forget, non-critical path) */
export const EVALUATION_COORDINATOR_TIMEOUT_MS = 5000;

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
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': '0',
      },
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
  ms: number = EVALUATION_COORDINATOR_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fn(controller.signal).finally(() => clearTimeout(timer));
}

/**
 * Fire POST /evaluate/:journeyId on evaluation-coordinator service.
 * Fire-and-forget in the handler — all outcomes (202, 422, 5xx, network) must be
 * absorbed by the caller's .catch().
 *
 * Behaviour:
 *   202 → resolve (accepted)
 *   422 → resolve (dedup — evaluation already in flight, non-fatal)
 *   5xx → throw  (so handler catch path is exercised)
 *   network error → throw (handler catch absorbs)
 *   missing env var → logger.warn + return immediately (no HTTP call, no throw)
 *
 * @param journeyId     Journey UUID to trigger evaluation for
 * @param correlationId X-Correlation-ID to forward (AC-5)
 */
export async function triggerEvaluation(
  journeyId: string,
  correlationId?: string
): Promise<void> {
  const evaluationCoordinatorUrl = process.env.EVALUATION_COORDINATOR_URL ?? '';

  // AC-4: Missing env var — warn and return immediately (non-fatal)
  if (!evaluationCoordinatorUrl) {
    logger.warn('triggerEvaluation: EVALUATION_COORDINATOR_URL not set — skipping trigger', {
      component: 'web-app-bff/evaluation-coordinator-client',
      journeyId,
    });
    return;
  }

  const url = `${evaluationCoordinatorUrl}/evaluate/${journeyId}`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (correlationId) {
    headers['x-correlation-id'] = correlationId;
  }

  logger.info('triggerEvaluation: firing POST to evaluation-coordinator', {
    component: 'web-app-bff/evaluation-coordinator-client',
    journeyId,
  });

  const { statusCode } = await withTimeout<{ statusCode: number; body: Record<string, unknown> }>(
    (signal) =>
      httpPost<Record<string, unknown>>(
        url,
        headers,
        signal
      ),
    EVALUATION_COORDINATOR_TIMEOUT_MS
  );

  // AC-3: 422 dedup — evaluation already in flight, treat as non-fatal success
  if (statusCode === 422) {
    logger.info('triggerEvaluation: 422 dedup — evaluation already in progress', {
      component: 'web-app-bff/evaluation-coordinator-client',
      journeyId,
      statusCode,
    });
    return;
  }

  // AC-2: 5xx → throw so the handler's .catch fires and absorbs it non-fatally
  if (statusCode >= 500) {
    const err = new Error(`triggerEvaluation: coordinator returned ${statusCode}`);
    logger.warn('triggerEvaluation: coordinator returned 5xx', {
      component: 'web-app-bff/evaluation-coordinator-client',
      journeyId,
      statusCode,
    });
    throw err;
  }

  // AC-1: 202 accepted — resolve
  logger.info('triggerEvaluation: coordinator accepted evaluation trigger', {
    component: 'web-app-bff/evaluation-coordinator-client',
    journeyId,
    statusCode,
  });
}
