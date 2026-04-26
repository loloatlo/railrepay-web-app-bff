/**
 * Auth-service HTTP client for web-app-bff
 *
 * Provides refreshAccessToken, startOtp, verifyOtp, revokeSession helpers.
 * All outbound calls are wrapped in a 5 s AbortController timeout (OQ-D lock).
 *
 * Also re-exports createSession from session-store so that integration
 * tests which import createSession from auth-service-client work correctly.
 *
 * Story   : RAILREPAY-WEB-BFF-002 / RAILREPAY-WEB-BFF-003
 * AC-8    : refreshAccessToken calls POST /auth/sessions/refresh
 * AC-1.1  : startOtp calls POST /auth/otp/start
 * AC-2.1  : verifyOtp calls POST /auth/otp/verify
 * AC-4.1  : revokeSession calls POST /auth/sessions/revoke (best-effort)
 * AC-1.6  : 5 s AbortController timeout on ALL calls
 * AC-10   : Uses @railrepay/winston-logger (not console.log)
 *
 * Mocked HTTP endpoints:
 *   POST {AUTH_SERVICE_URL}/auth/sessions/refresh
 *   POST {AUTH_SERVICE_URL}/auth/otp/start
 *   POST {AUTH_SERVICE_URL}/auth/otp/verify
 *   POST {AUTH_SERVICE_URL}/auth/sessions/revoke
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import http from 'node:http';
import https from 'node:https';
import { createLogger } from '@railrepay/winston-logger';
import type { Redis } from 'ioredis';
import { getSession, sessionRedisKey, SESSION_TTL_SECONDS } from './session-store.js';

/** Outbound HTTP timeout — 5 s AbortController (OQ-D lock, WEB-BFF-003) */
export const AUTH_SERVICE_TIMEOUT_MS = 5000;

// Re-export createSession so integration tests that import from auth-service-client work
export { createSession } from './session-store.js';

const logger = createLogger({
  serviceName: process.env.SERVICE_NAME ?? 'web-app-bff',
  level: process.env.LOG_LEVEL ?? 'info',
  environment: process.env.NODE_ENV ?? 'development',
});

/**
 * Minimal HTTP POST helper using Node's built-in http/https modules.
 * Uses http/https (not native fetch) so that nock can intercept in tests.
 * Accepts an optional AbortSignal for timeout support.
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

    // Honour AbortSignal — destroy request on abort
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
 * On timeout, rejects with an Error whose message is 'AbortError'.
 *
 * @param fn    Factory that receives an AbortSignal and returns a Promise<T>
 * @param ms    Timeout in milliseconds (default: AUTH_SERVICE_TIMEOUT_MS)
 */
function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number = AUTH_SERVICE_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fn(controller.signal).finally(() => clearTimeout(timer));
}

/** VerifyOtpResult from auth-service (WEB-BFF-003) */
export interface VerifyOtpResult {
  user_id: string;
  session_id: string;
  access_token: string;
  expires_in: number;
}

/**
 * Call POST /auth/otp/start on auth-service.
 * Returns { statusCode, body } for the handler to interpret.
 * Wrapped with 5 s AbortController timeout (AC-1.6).
 *
 * @param phone_e164    E.164 phone number
 * @param channel       'web' | 'rn' | 'swift'
 * @param correlationId Optional x-correlation-id to forward
 */
export async function startOtp(
  phone_e164: string,
  channel: string,
  correlationId?: string
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const authServiceUrl = process.env.AUTH_SERVICE_URL ?? '';
  const url = `${authServiceUrl}/auth/otp/start`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (correlationId) {
    headers['x-correlation-id'] = correlationId;
  }

  logger.info('startOtp: calling auth-service', {
    component: 'web-app-bff/auth-service-client',
  });

  try {
    const { statusCode, body } = await withTimeout<{ statusCode: number; body: Record<string, unknown> }>(
      (signal) =>
        httpPost<Record<string, unknown>>(
          url,
          { phone_e164, channel },
          headers,
          signal
        ),
      AUTH_SERVICE_TIMEOUT_MS
    );
    return { statusCode, body };
  } catch (err) {
    logger.warn('startOtp: request failed or timed out', {
      component: 'web-app-bff/auth-service-client',
      error: err instanceof Error ? err.message : String(err),
    });
    return { statusCode: 503, body: { error: 'upstream_unavailable' } };
  }
}

/**
 * Call POST /auth/otp/verify on auth-service.
 * Returns { statusCode, body } for the handler to interpret.
 * Wrapped with 5 s AbortController timeout (AC-1.6).
 *
 * @param phone_e164    E.164 phone number
 * @param channel       'web' | 'rn' | 'swift'
 * @param code          OTP code (4-10 digit numeric)
 * @param correlationId Optional x-correlation-id to forward
 */
export async function verifyOtp(
  phone_e164: string,
  channel: string,
  code: string,
  correlationId?: string
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const authServiceUrl = process.env.AUTH_SERVICE_URL ?? '';
  const url = `${authServiceUrl}/auth/otp/verify`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (correlationId) {
    headers['x-correlation-id'] = correlationId;
  }

  logger.info('verifyOtp: calling auth-service', {
    component: 'web-app-bff/auth-service-client',
  });

  try {
    const { statusCode, body } = await withTimeout<{ statusCode: number; body: Record<string, unknown> }>(
      (signal) =>
        httpPost<Record<string, unknown>>(
          url,
          { phone_e164, channel, code },
          headers,
          signal
        ),
      AUTH_SERVICE_TIMEOUT_MS
    );
    return { statusCode, body };
  } catch (err) {
    logger.warn('verifyOtp: request failed or timed out', {
      component: 'web-app-bff/auth-service-client',
      error: err instanceof Error ? err.message : String(err),
    });
    return { statusCode: 503, body: { error: 'upstream_unavailable' } };
  }
}

/**
 * Call POST /auth/sessions/revoke on auth-service (best-effort).
 * Swallows ALL errors — UX hardening: logout must succeed even when revoke fails (AC-4.3).
 *
 * @param accessToken   The session's access_token used as Bearer
 */
export async function revokeSession(accessToken: string): Promise<void> {
  const authServiceUrl = process.env.AUTH_SERVICE_URL ?? '';
  const url = `${authServiceUrl}/auth/sessions/revoke`;

  logger.info('revokeSession: calling auth-service revoke', {
    component: 'web-app-bff/auth-service-client',
  });

  try {
    await withTimeout<{ statusCode: number; body: Record<string, unknown> }>(
      (signal) =>
        httpPost<Record<string, unknown>>(
          url,
          null,
          {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          signal
        ),
      AUTH_SERVICE_TIMEOUT_MS
    );
  } catch (err) {
    // Swallow all errors — UX hardening (AC-4.3)
    logger.warn('revokeSession: auth-service revoke failed (swallowed)', {
      component: 'web-app-bff/auth-service-client',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Error thrown when the auth-service returns 401 (session has expired
 * and cannot be refreshed).
 */
export class SessionExpiredError extends Error {
  constructor(message = 'Session expired — auth-service returned 401') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

/**
 * Refresh the access token for the given session.
 *
 * 1. Fetches the current session from Redis
 * 2. Calls POST {AUTH_SERVICE_URL}/auth/sessions/refresh with current Bearer token
 * 3. On 200 → updates Redis row with new access_token and refresh_at_iso
 * 4. On 401 → throws SessionExpiredError
 *
 * @param redis - ioredis client
 * @param sessionId - session identifier
 * @throws SessionExpiredError when auth-service returns 401
 * @throws Error when session not found in Redis
 */
export async function refreshAccessToken(
  redis: Pick<Redis, 'get' | 'expire' | 'set'>,
  sessionId: string
): Promise<void> {
  const session = await getSession(redis, sessionId);

  if (!session) {
    throw new Error(`refreshAccessToken: session not found in Redis for sid ${sessionId}`);
  }

  const authServiceUrl = process.env.AUTH_SERVICE_URL ?? '';
  const url = `${authServiceUrl}/auth/sessions/refresh`;

  logger.info('refreshAccessToken: calling auth-service refresh endpoint', {
    component: 'web-app-bff/auth-service-client',
  });

  const { statusCode, body } = await withTimeout<{ statusCode: number; body: { access_token: string; expires_in: number } }>(
    (signal) =>
      httpPost<{ access_token: string; expires_in: number }>(
        url,
        null,
        { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        signal
      ),
    AUTH_SERVICE_TIMEOUT_MS
  );

  if (statusCode === 401) {
    logger.warn('refreshAccessToken: auth-service returned 401 — session expired', {
      component: 'web-app-bff/auth-service-client',
    });
    throw new SessionExpiredError();
  }

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(
      `refreshAccessToken: auth-service returned unexpected status ${statusCode}`
    );
  }

  // Update Redis row with new token
  const key = sessionRedisKey(sessionId);
  const updatedSession = {
    ...session,
    access_token: body.access_token,
    refresh_at_iso: new Date().toISOString(),
  };

  await redis.set(key, JSON.stringify(updatedSession), 'EX', SESSION_TTL_SECONDS);

  logger.info('refreshAccessToken: Redis session updated with new access_token', {
    component: 'web-app-bff/auth-service-client',
  });
}
