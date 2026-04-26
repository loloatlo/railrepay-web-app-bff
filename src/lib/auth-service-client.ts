/**
 * Auth-service HTTP client for web-app-bff
 *
 * Provides refreshAccessToken helper that calls the auth-service
 * POST /auth/sessions/refresh endpoint to obtain a new access token,
 * then updates the Redis session row with the new token.
 *
 * Also re-exports createSession from session-store so that integration
 * tests which import createSession from auth-service-client work correctly.
 *
 * Story   : RAILREPAY-WEB-BFF-002
 * AC-8    : refreshAccessToken calls POST /auth/sessions/refresh
 * AC-10   : Uses @railrepay/winston-logger (not console.log)
 *
 * Mocked HTTP endpoint:
 *   POST {AUTH_SERVICE_URL}/auth/sessions/refresh
 *   Verified real: services/auth-service/src/handlers/refresh.handler.ts handleRefresh
 *   Exposed at: services/auth-service/src/routes/sessions.ts mounted at /auth/sessions/refresh
 *   Last verified: 2026-04-26 (Jessie WEB-BFF-002 US-2)
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

    const payload = body !== null ? JSON.stringify(body) : '';

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

  const { statusCode, body } = await httpPost<{ access_token: string; expires_in: number }>(
    url,
    null,
    { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }
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
