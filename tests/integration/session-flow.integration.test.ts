/**
 * Integration Tests: end-to-end session flow
 *
 * Story   : RAILREPAY-WEB-BFF-002
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates src/lib/session-store.ts and src/lib/auth-service-client.ts.
 * Failure reason: module-not-found or real Redis container not yet wired in src/.
 *
 * AC coverage map:
 *   AC-11: End-to-end "set cookie → read session → slide TTL" flow:
 *           simulate session creation (direct call to createSession),
 *           follow-up getSession returns same user_id,
 *           TTL is slid on each read.
 *   AC-2:  Redis TTL set to 2592000 on createSession; slid on getSession.
 *   AC-3:  createSession returns {sessionId, expiresAt}.
 *   AC-8:  refreshAccessToken updates Redis row with new token.
 *   AC-7 (integration): Bearer token produces req.session.source='bearer';
 *          cookie takes precedence over Bearer when both present.
 *
 * Infrastructure:
 *   - Testcontainers Redis for real I/O (not mocked)
 *   - nock for auth-service HTTP stub
 *
 * Mocked HTTP (nock):
 *   // Mocked: POST {AUTH_SERVICE_URL}/auth/sessions/refresh
 *   // Verified real: services/auth-service/src/handlers/refresh.handler.ts handleRefresh
 *   // Exposed at: services/auth-service/src/routes/sessions.ts → router.post('/refresh', ...)
 *   //             mounted at: services/auth-service/src/app.ts → /auth/sessions
 *   // Full URL: AUTH_SERVICE_URL/auth/sessions/refresh
 *   // Last verified: 2026-04-26 (Jessie WEB-BFF-002 US-2)
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §7 — Integration tests required
 *   CLAUDE.md §6.1 #10 — Mocked Endpoint Verification
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import nock from 'nock';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  happyPathSession,
  SESSION_TTL_SECONDS,
  sessionRedisKey,
} from '../fixtures/session-data.js';
import {
  tokens,
  TEST_JWT_SECRET,
  TEST_JWT_ISSUER,
  TEST_JWT_AUDIENCE,
  TEST_USER_ID,
  TEST_SESSION_ID,
  type TokenSet,
} from '../fixtures/jwt-tokens.js';

// ─── Shared logger mock ────────────────────────────────────────────────────────
const sharedLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

const AUTH_SERVICE_URL = 'http://auth-service-integration-stub:9998';

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-002: session flow integration tests (Testcontainers Redis)', () => {
  let container: StartedTestContainer;
  let redis: Redis;
  let tokenSet: TokenSet;

  beforeAll(async () => {
    // Start real Redis via Testcontainers
    container = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .start();

    const redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
    redis = new Redis(redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 0 });

    process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    process.env.JWT_ISSUER = TEST_JWT_ISSUER;
    process.env.JWT_AUDIENCE = TEST_JWT_AUDIENCE;
    process.env.SESSION_COOKIE_NAME = 'rr_session';
    process.env.NODE_ENV = 'test';

    tokenSet = await tokens;
    nock.cleanAll();
  }, 120000);

  afterAll(async () => {
    nock.cleanAll();
    await redis.quit();
    await container.stop();
    delete process.env.AUTH_SERVICE_URL;
    delete process.env.JWT_SECRET;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    delete process.env.SESSION_COOKIE_NAME;
    delete process.env.NODE_ENV;
  });

  // ─── AC-11 + AC-3: createSession → getSession round-trip ─────────────────

  describe('AC-11 + AC-3: createSession then getSession returns same user_id', () => {
    it('AC-11: createSession stores data and getSession retrieves it from real Redis', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createSession, getSession } = await import('../../src/lib/session-store.js');

      const { sessionId } = await createSession(redis, {
        user_id: happyPathSession.user_id,
        access_token: happyPathSession.access_token,
      });

      const retrieved = await getSession(redis, sessionId);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.user_id).toBe(happyPathSession.user_id);
      expect(retrieved!.session_id).toBe(sessionId);
    });

    it('AC-11: getSession after createSession should slide TTL to 2592000', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createSession, getSession } = await import('../../src/lib/session-store.js');

      const { sessionId } = await createSession(redis, {
        user_id: happyPathSession.user_id,
        access_token: happyPathSession.access_token,
      });

      await getSession(redis, sessionId);

      const key = sessionRedisKey(sessionId);
      const ttl = await redis.ttl(key);

      // TTL should be ≈ SESSION_TTL_SECONDS (within a few seconds of variance)
      expect(ttl).toBeGreaterThan(SESSION_TTL_SECONDS - 5);
      expect(ttl).toBeLessThanOrEqual(SESSION_TTL_SECONDS);
    });

    it('AC-11: getSession for non-existent session should return null', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getSession } = await import('../../src/lib/session-store.js');

      const result = await getSession(redis, 'sid-totally-nonexistent-xyz');

      expect(result).toBeNull();
    });

    it('AC-3: createSession should set Redis key with EX 2592000', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createSession } = await import('../../src/lib/session-store.js');

      const { sessionId } = await createSession(redis, {
        user_id: 'usr-ttl-test',
        access_token: 'tok-ttl-test',
      });

      const key = sessionRedisKey(sessionId);
      const ttl = await redis.ttl(key);

      // Freshly created — TTL should be very close to 30 days
      expect(ttl).toBeGreaterThan(SESSION_TTL_SECONDS - 5);
      expect(ttl).toBeLessThanOrEqual(SESSION_TTL_SECONDS);
    });
  });

  // ─── AC-8 + AC-11: refreshAccessToken updates Redis ─────────────────────

  describe('AC-8: refreshAccessToken updates Redis row with new access_token', () => {
    it('AC-8: refreshAccessToken should update the Redis row with new access_token', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createSession, refreshAccessToken } = await import('../../src/lib/auth-service-client.js');
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getSession } = await import('../../src/lib/session-store.js');

      // Create a session first
      const { sessionId } = await createSession(redis, {
        user_id: happyPathSession.user_id,
        access_token: happyPathSession.access_token,
      });

      const newAccessToken = 'new-access-token-from-auth-service';

      // Mocked: POST {AUTH_SERVICE_URL}/auth/sessions/refresh
      // Verified real: services/auth-service/src/handlers/refresh.handler.ts handleRefresh
      // Exposed at: services/auth-service/src/routes/sessions.ts mounted at /auth/sessions/refresh
      // Last verified: 2026-04-26 (Jessie WEB-BFF-002 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/refresh')
        .reply(200, { access_token: newAccessToken, expires_in: 900 });

      await refreshAccessToken(redis, sessionId);

      const updated = await getSession(redis, sessionId);
      expect(updated).not.toBeNull();
      expect(updated!.access_token).toBe(newAccessToken);
    });

    it('AC-8: refreshAccessToken should throw SessionExpiredError when auth-service returns 401', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createSession, refreshAccessToken, SessionExpiredError } = await import('../../src/lib/auth-service-client.js');

      const { sessionId } = await createSession(redis, {
        user_id: 'usr-expired-test',
        access_token: 'tok-expired',
      });

      // Mocked: POST {AUTH_SERVICE_URL}/auth/sessions/refresh (401)
      // Verified real: services/auth-service/src/handlers/refresh.handler.ts handleRefresh
      // Exposed at: services/auth-service/src/routes/sessions.ts mounted at /auth/sessions/refresh
      // Last verified: 2026-04-26 (Jessie WEB-BFF-002 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/refresh')
        .reply(401, { error: 'unauthorized' });

      await expect(refreshAccessToken(redis, sessionId)).rejects.toThrow(SessionExpiredError);
    });
  });

  // ─── AC-7 (integration): Bearer fallback with real jose verify ───────────

  describe('AC-7 (integration): Bearer fallback with real HS256 verification', () => {
    it('AC-7: valid Bearer token should populate req.session on a real Express app', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createBearerFallbackMiddleware } = await import('../../src/middleware/bearer-fallback.js');

      const app = express();
      app.use(cookieParser());
      app.use(createBearerFallbackMiddleware());

      let capturedSession: unknown;
      app.get('/test', (req, res) => {
        capturedSession = (req as Record<string, unknown>).session;
        res.json({ ok: true });
      });

      const res = await request(app)
        .get('/test')
        .set('Authorization', `Bearer ${tokenSet.valid}`);

      expect(res.status).toBe(200);
      expect((capturedSession as Record<string, string>).user_id).toBe(TEST_USER_ID);
      expect((capturedSession as Record<string, string>).session_id).toBe(TEST_SESSION_ID);
      expect((capturedSession as Record<string, string>).source).toBe('bearer');
    });

    it('AC-7 (integration): expired Bearer token should return 401', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createBearerFallbackMiddleware } = await import('../../src/middleware/bearer-fallback.js');

      const app = express();
      app.use(cookieParser());
      app.use(createBearerFallbackMiddleware());
      app.get('/test', (_req, res) => res.json({ ok: true }));

      const res = await request(app)
        .get('/test')
        .set('Authorization', `Bearer ${tokenSet.expired}`);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized' });
    });
  });
});
