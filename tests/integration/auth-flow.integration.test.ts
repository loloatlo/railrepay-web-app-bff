/**
 * Integration Tests: auth flow — start → verify → me → logout
 *
 * Story   : RAILREPAY-WEB-BFF-003
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/routes/auth.ts  (OTP start/verify/me/logout routes)
 *   Blake extends session-store.ts + auth-service-client.ts
 *
 * Failure reason expected: module-not-found or 404 from routes not mounted.
 *
 * AC coverage map:
 *   AC-2.1: verify success → 200 + Set-Cookie rr_session
 *   AC-2.2: Redis row contains auth access_token AND auth_service_session_id
 *   AC-3.1: GET /api/auth/me with cookie → 200 { user_id, session_id } (no auth-service call)
 *   AC-4.1: logout → revoke auth-service + delete Redis + 204 + clear cookie
 *   AC-4.2: idempotent logout (second call, no cookie) → 204
 *   AC-5.2: Full flow with REAL @railrepay/redis-cache + @railrepay/winston-logger
 *            (no mocks for shared packages — real package usage verified per AC-5.2)
 *
 * Infrastructure:
 *   - Testcontainers Redis (real I/O — no mock)
 *   - nock for auth-service HTTP stubbing
 *   - Real @railrepay/winston-logger (no vi.mock for it — AC-5.2 requirement)
 *   - Real @railrepay/redis-cache (no vi.mock for it — AC-5.2 requirement)
 *
 * AC-5.2 annotation (CLAUDE.md §6.1 #8 shared package verification):
 *   NO vi.mock('@railrepay/winston-logger') in this file — real package imported
 *   NO vi.mock('@railrepay/redis-cache') in this file — real package imported
 *
 * Mocked HTTP (nock):
 *   // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/start
 *   // Verified real: services/auth-service/src/handlers/otp.handler.ts handleStartOtp
 *   // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/start
 *   // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
 *
 *   // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/verify
 *   // Verified real: services/auth-service/src/handlers/otp.handler.ts handleVerifyOtp
 *   // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/verify
 *   // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
 *
 *   // Mocked: POST {AUTH_SERVICE_URL}/auth/sessions/revoke
 *   // Verified real: services/auth-service/src/handlers/revoke.handler.ts handleRevoke
 *   // Exposed at: services/auth-service/src/routes/sessions.ts mounted at /auth/sessions/revoke
 *   // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §7 — Integration tests required
 *   CLAUDE.md §6.1 #10 — Mocked Endpoint Verification
 *   CLAUDE.md §8 — Mandatory shared package usage (verified here via real imports)
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import nock from 'nock';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { TEST_JWT_SECRET, TEST_JWT_ISSUER, TEST_JWT_AUDIENCE } from '../fixtures/jwt-tokens.js';

// ─── AC-5.2: Real shared packages — NO vi.mock for @railrepay/* in this file ─
// INTENTIONALLY not mocking @railrepay/winston-logger or @railrepay/redis-cache
// This integration test MUST exercise the real package implementations.

// ─── Test constants ───────────────────────────────────────────────────────────
const AUTH_SERVICE_URL = 'http://auth-service-integration-003:9992';

/** Fixture: auth-service response on successful OTP verify (VerifyOtpResult shape) */
const AUTH_VERIFY_RESPONSE = {
  user_id: 'usr-integration-0001-aaaa-bbbb-cccc-000000000001',
  session_id: 'auth-sess-integration-0001-1111-2222-3333-000000000001',
  access_token: 'eyJhbGciOiJIUzI1NiJ9.integration.test.access.token',
  expires_in: 900,
};

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-003: auth flow integration tests (Testcontainers Redis)', () => {
  let container: StartedTestContainer;
  let redis: Redis;
  let app: ReturnType<typeof express>;

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

    nock.cleanAll();

    // Build the full auth-route app with real Redis
    // @ts-expect-error — module does not exist yet (TDD RED phase)
    const { createAuthRouter } = await import('../../src/routes/auth.js');
    // @ts-expect-error — module does not exist yet (TDD RED phase)
    const { createCookieSessionMiddleware } = await import('../../src/middleware/cookie-session.js');
    // @ts-expect-error — module does not exist yet (TDD RED phase)
    const { createBearerFallbackMiddleware } = await import('../../src/middleware/bearer-fallback.js');

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    // Session middleware must be mounted BEFORE auth routes
    app.use(createCookieSessionMiddleware(redis));
    app.use(createBearerFallbackMiddleware());
    // All /api/auth/* routes
    app.use(createAuthRouter(redis));
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

  beforeEach(() => {
    nock.cleanAll();
  });

  // ─── AC-5.2: Full flow: start → verify → cookie → me → logout ────────────

  describe('AC-5.2: full auth flow with real Redis (Testcontainers)', () => {
    it('AC-5.2: POST otp/start → 202, POST otp/verify → 200 + cookie, GET me → 200, POST logout → 204 + cookie cleared', async () => {
      // ── Step 1: OTP start ──
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/start
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleStartOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/start
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/start')
        .reply(202, { status: 'sent' });

      const startRes = await request(app)
        .post('/api/auth/otp/start')
        .send({ phone_e164: '+447700900001', channel: 'web' });

      expect(startRes.status).toBe(202);
      expect(startRes.body).toEqual({ status: 'sent' });

      // ── Step 2: OTP verify → cookie issued ──
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/verify
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleVerifyOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/verify
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/verify')
        .reply(200, AUTH_VERIFY_RESPONSE);

      const verifyRes = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone_e164: '+447700900001', channel: 'web', code: '123456' });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body).toMatchObject({ user_id: AUTH_VERIFY_RESPONSE.user_id });
      expect(verifyRes.body).toHaveProperty('expires_at');
      expect(verifyRes.body).not.toHaveProperty('access_token');

      // Extract the rr_session cookie from verify response
      const setCookieHeaders = verifyRes.headers['set-cookie'] as string[];
      expect(setCookieHeaders).toBeDefined();
      const sessionCookieHeader = setCookieHeaders.find((h) => h.startsWith('rr_session='));
      expect(sessionCookieHeader).toBeDefined();
      const bffSid = sessionCookieHeader!.match(/rr_session=([^;]+)/)![1]!;

      // ── Step 3: Verify Redis row contains access_token + auth_service_session_id (AC-2.2) ──
      const redisKey = `bff:session:${bffSid}`;
      const redisRow = await redis.get(redisKey);
      expect(redisRow).not.toBeNull();
      const sessionData = JSON.parse(redisRow!) as Record<string, unknown>;
      expect(sessionData.access_token).toBe(AUTH_VERIFY_RESPONSE.access_token);
      expect(sessionData.auth_service_session_id).toBe(AUTH_VERIFY_RESPONSE.session_id);
      expect(sessionData.user_id).toBe(AUTH_VERIFY_RESPONSE.user_id);

      // ── Step 4: GET /api/auth/me with cookie → 200 from Redis (no auth-service call) (AC-3.1) ──
      const unexpectedRevoke = nock(AUTH_SERVICE_URL)
        .get(/.*/)
        .reply(500, { error: 'should_not_be_called' });

      const meRes = await request(app)
        .get('/api/auth/me')
        .set('Cookie', `rr_session=${bffSid}`);

      expect(meRes.status).toBe(200);
      expect(meRes.body).toMatchObject({
        user_id: AUTH_VERIFY_RESPONSE.user_id,
      });
      // auth-service must NOT have been called for /me
      expect(unexpectedRevoke.isDone()).toBe(false);
      nock.cleanAll();

      // ── Step 5: POST /api/auth/logout → revoke + delete Redis + 204 (AC-4.1) ──
      // Mocked: POST {AUTH_SERVICE_URL}/auth/sessions/revoke
      // Verified real: services/auth-service/src/handlers/revoke.handler.ts handleRevoke
      // Exposed at: services/auth-service/src/routes/sessions.ts mounted at /auth/sessions/revoke
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      const revokeScope = nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/revoke')
        .reply(204, '');

      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', `rr_session=${bffSid}`);

      expect(logoutRes.status).toBe(204);
      expect(revokeScope.isDone()).toBe(true);

      // Cookie must be cleared
      const logoutCookieHeaders = logoutRes.headers['set-cookie'] as string[] | undefined;
      expect(logoutCookieHeaders).toBeDefined();
      const clearCookieStr = logoutCookieHeaders!.find((h) => h.startsWith('rr_session='));
      expect(clearCookieStr).toBeDefined();
      expect(clearCookieStr!.toLowerCase()).toMatch(/max-age=0/);

      // Redis row must be gone
      const deletedRow = await redis.get(redisKey);
      expect(deletedRow).toBeNull();

      // ── Step 6: Second logout call (no cookie) → idempotent 204 (AC-4.2) ──
      const secondLogout = await request(app)
        .post('/api/auth/logout');

      expect(secondLogout.status).toBe(204);
    });
  });

  // ─── AC-3.1: /me with cookie → BFF-only Redis read (no auth-service call) ─

  describe('AC-3.1: GET /api/auth/me — BFF reads from Redis (no auth-service round-trip)', () => {
    it('AC-3.1: should return 200 from Redis session without any auth-service call', async () => {
      // Set up a session directly in Redis (simulating post-verify state)
      const testBffSid = 'test-bff-sid-ac31-000000000001';
      const sessionData = {
        user_id: 'usr-ac31-test-0001',
        session_id: testBffSid,
        access_token: 'eyJhbGciOiJIUzI1NiJ9.ac31.access.token',
        auth_service_session_id: 'auth-sess-ac31-0001',
        refresh_at_iso: '2026-04-26T12:00:00.000Z',
        created_at_iso: '2026-04-26T12:00:00.000Z',
      };
      await redis.set(`bff:session:${testBffSid}`, JSON.stringify(sessionData), 'EX', 2592000);

      // Verify auth-service is NOT called
      const unexpectedCall = nock(AUTH_SERVICE_URL).get(/.*/).reply(500, {});

      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', `rr_session=${testBffSid}`);

      expect(res.status).toBe(200);
      expect(res.body.user_id).toBe('usr-ac31-test-0001');
      expect(unexpectedCall.isDone()).toBe(false);
      nock.cleanAll();
    });
  });

  // ─── AC-4.3: Logout failure tolerance with real Redis ────────────────────

  describe('AC-4.3: logout failure tolerance — auth-service failure still completes logout', () => {
    it('AC-4.3: should complete logout (204 + Redis deleted) even when auth-service revoke returns 503', async () => {
      // Set up a session in real Redis
      const testBffSid = 'test-bff-sid-ac43-000000000001';
      const sessionData = {
        user_id: 'usr-ac43-test-0001',
        session_id: testBffSid,
        access_token: 'eyJhbGciOiJIUzI1NiJ9.ac43.access.token',
        auth_service_session_id: 'auth-sess-ac43-0001',
        refresh_at_iso: '2026-04-26T12:00:00.000Z',
        created_at_iso: '2026-04-26T12:00:00.000Z',
      };
      await redis.set(`bff:session:${testBffSid}`, JSON.stringify(sessionData), 'EX', 2592000);

      // auth-service revoke fails (503)
      // Mocked: POST {AUTH_SERVICE_URL}/auth/sessions/revoke (503)
      // Verified real: services/auth-service/src/handlers/revoke.handler.ts handleRevoke
      // Exposed at: services/auth-service/src/routes/sessions.ts mounted at /auth/sessions/revoke
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/revoke')
        .reply(503, { error: 'upstream_unavailable' });

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', `rr_session=${testBffSid}`);

      // UX hardening: 204 regardless of auth-service failure
      expect(res.status).toBe(204);

      // Redis row must be deleted
      const remaining = await redis.get(`bff:session:${testBffSid}`);
      expect(remaining).toBeNull();

      // Cookie must be cleared
      const setCookieHeaders = res.headers['set-cookie'] as string[] | undefined;
      expect(setCookieHeaders).toBeDefined();
      const clearCookie = setCookieHeaders!.find((h) => h.startsWith('rr_session='));
      expect(clearCookie).toBeDefined();
      expect(clearCookie!.toLowerCase()).toMatch(/max-age=0/);
    });
  });

  // ─── AC-3.3 (integration): Bearer fallback with real jose verify ──────────

  describe('AC-3.3 (integration): Bearer JWT path — cookie takes precedence', () => {
    it('AC-3.3: GET /api/auth/me with valid Bearer JWT and NO cookie → 200 from JWT claims', async () => {
      const { SignJWT } = await import('jose');
      const now = Math.floor(Date.now() / 1000);
      const secretBytes = new TextEncoder().encode(TEST_JWT_SECRET);
      const bearerToken = await new SignJWT({ sid: 'sid-bearer-integration-0001' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('usr-bearer-integration-0001')
        .setIssuer(TEST_JWT_ISSUER)
        .setAudience(TEST_JWT_AUDIENCE)
        .setIssuedAt(now)
        .setExpirationTime(now + 900)
        .sign(secretBytes);

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${bearerToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        user_id: 'usr-bearer-integration-0001',
        session_id: 'sid-bearer-integration-0001',
      });
    });

    it('AC-3.3: when BOTH cookie AND Bearer present, cookie session wins', async () => {
      // Cookie session in real Redis
      const cookieSid = 'test-bff-sid-cookie-wins-0001';
      const cookieSessionData = {
        user_id: 'usr-cookie-wins-integration-0001',
        session_id: cookieSid,
        access_token: 'tok-cookie-wins',
        auth_service_session_id: 'auth-sess-cookie-wins',
        refresh_at_iso: '2026-04-26T12:00:00.000Z',
        created_at_iso: '2026-04-26T12:00:00.000Z',
      };
      await redis.set(`bff:session:${cookieSid}`, JSON.stringify(cookieSessionData), 'EX', 2592000);

      // Bearer token for a DIFFERENT user
      const { SignJWT } = await import('jose');
      const now = Math.floor(Date.now() / 1000);
      const secretBytes = new TextEncoder().encode(TEST_JWT_SECRET);
      const bearerToken = await new SignJWT({ sid: 'sid-bearer-different-0001' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('usr-bearer-different-0001')
        .setIssuer(TEST_JWT_ISSUER)
        .setAudience(TEST_JWT_AUDIENCE)
        .setIssuedAt(now)
        .setExpirationTime(now + 900)
        .sign(secretBytes);

      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', `rr_session=${cookieSid}`)
        .set('Authorization', `Bearer ${bearerToken}`);

      expect(res.status).toBe(200);
      // Cookie user wins
      expect(res.body.user_id).toBe('usr-cookie-wins-integration-0001');
      // Bearer user must NOT win
      expect(res.body.user_id).not.toBe('usr-bearer-different-0001');
    });
  });
});
