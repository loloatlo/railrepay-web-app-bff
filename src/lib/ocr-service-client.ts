/**
 * OCR-service HTTP client for web-app-bff
 *
 * Provides submitScan and getScanResult helpers.
 * All outbound calls are wrapped in a 5 s AbortController timeout (AC-13 lock).
 *
 * Story   : RAILREPAY-WEB-BFF-004
 * AC-6    : submitScan POSTs to {OCR_SERVICE_URL}/ocr/scan with JSON body
 *           { image_base64, content_type, user_id, correlation_id, source? }
 * AC-13   : 5s AbortController timeout on ALL ocr-service-client calls.
 * AC-14   : x-correlation-id forwarded to ocr in BOTH submitScan and getScanResult.
 *
 * Mocked HTTP endpoints (verified real):
 *   POST {OCR_SERVICE_URL}/ocr/scan
 *   Verified real: services/ocr/src/handlers/scan.handler.ts createScanHandler
 *   Exposed at: services/ocr/src/index.ts mounted at /ocr/scan
 *   Last verified: 2026-04-27 (Jessie WEB-BFF-004 US-2)
 *
 *   GET {OCR_SERVICE_URL}/ocr/results/:scanId
 *   Verified real: services/ocr/src/handlers/results.handler.ts createResultsHandler
 *   Exposed at: services/ocr/src/index.ts mounted at /ocr/results/:scanId
 *   Last verified: 2026-04-27 (Jessie WEB-BFF-004 US-2)
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-014 — TDD
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import http from 'node:http';
import https from 'node:https';
import { createLogger } from '@railrepay/winston-logger';

/** Outbound HTTP timeout — 5 s AbortController (AC-13 lock, WEB-BFF-004) */
export const OCR_SERVICE_TIMEOUT_MS = 5000;

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
  headers: Record<string, string>
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

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * Minimal HTTP GET helper using Node's built-in http/https modules.
 * Uses http/https (not native fetch) so that nock can intercept in tests.
 */
function httpGet<T>(
  url: string,
  headers: Record<string, string>
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

    req.end();
  });
}

/**
 * Wrap a promise with an AbortController-based timeout using Promise.race.
 * On timeout, rejects with an Error('AbortError').
 * Uses setTimeout (affected by vitest fake timers) for the timeout signal.
 *
 * @param promiseFn  Factory that returns a Promise<T>
 * @param ms         Timeout in milliseconds (default: OCR_SERVICE_TIMEOUT_MS)
 */
function withTimeout<T>(
  promiseFn: () => Promise<T>,
  ms: number = OCR_SERVICE_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('AbortError'));
    }, ms);
  });

  return Promise.race([promiseFn(), timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

/** Input params for submitScan */
export interface SubmitScanParams {
  imageBase64: string;
  contentType: string;
  userId: string;
  correlationId: string;
  source?: string;
}

/** Input params for getScanResult */
export interface GetScanResultParams {
  scanId: string;
  correlationId: string;
}

/**
 * Submit an image scan to the OCR service.
 * POSTs to {OCR_SERVICE_URL}/ocr/scan with JSON body
 * { image_base64, content_type, user_id, correlation_id, source? }
 *
 * Returns { statusCode, body } for the handler to interpret.
 * Wrapped with 5 s AbortController timeout (AC-13).
 * Forwards x-correlation-id to ocr (AC-14).
 *
 * @param params - scan submission parameters
 */
export async function submitScan(
  params: SubmitScanParams
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const ocrServiceUrl = process.env.OCR_SERVICE_URL ?? '';
  const url = `${ocrServiceUrl}/ocr/scan`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-correlation-id': params.correlationId,
  };

  // Build request body — omit source if not provided (AC-7)
  const requestBody: Record<string, unknown> = {
    image_base64: params.imageBase64,
    content_type: params.contentType,
    user_id: params.userId,
    correlation_id: params.correlationId,
  };

  if (params.source !== undefined) {
    requestBody.source = params.source;
  }

  logger.info('submitScan: calling ocr-service', {
    component: 'web-app-bff/ocr-service-client',
  });

  return withTimeout<{ statusCode: number; body: Record<string, unknown> }>(
    () =>
      httpPost<Record<string, unknown>>(
        url,
        requestBody,
        headers
      ),
    OCR_SERVICE_TIMEOUT_MS
  );
}

/**
 * Retrieve scan results from the OCR service.
 * GETs from {OCR_SERVICE_URL}/ocr/results/<scanId>.
 *
 * Returns { statusCode, body } for the handler to interpret.
 * Wrapped with 5 s AbortController timeout (AC-13).
 * Forwards x-correlation-id to ocr (AC-14).
 *
 * @param params - get scan result parameters
 */
export async function getScanResult(
  params: GetScanResultParams
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const ocrServiceUrl = process.env.OCR_SERVICE_URL ?? '';
  const url = `${ocrServiceUrl}/ocr/results/${params.scanId}`;

  const headers: Record<string, string> = {
    'x-correlation-id': params.correlationId,
  };

  logger.info('getScanResult: calling ocr-service', {
    component: 'web-app-bff/ocr-service-client',
  });

  return withTimeout<{ statusCode: number; body: Record<string, unknown> }>(
    () =>
      httpGet<Record<string, unknown>>(
        url,
        headers
      ),
    OCR_SERVICE_TIMEOUT_MS
  );
}
