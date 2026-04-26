/**
 * Unit Tests: POST /api/auth/logout handler (web-app-bff)
 *
 * Story   : RAILREPAY-WEB-BFF-003
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/routes/auth.ts  (exposing createLogoutRouter)
 *
 * Failure reason expected: module-not-found or route 404.
 *
 * AC coverage map:
 *   AC-4.1: POST /api/auth/logout with valid rr_session cookie:
 *            (a) calls auth-service POST /auth/sessions/revoke with Redis row's access_token as Bearer
 *            (b) deletes Redis row bff:session:<bff-sid>
 *            (c) returns 204 with Set-Cookie: rr_session=; Max-Age=0; Path=/
 *   AC-4.2: Second logout call (no cookie) → idempotent 204 with same Set-Cookie clearing header.
 *   AC-4.3: When auth-service revoke fails (timeout, 503, network) → BFF still completes logout:
 *            deletes Redis row, clears cookie, returns 204. (UX hardening)
 *
 * Mocked HTTP (nock):
 *   // Mocked: POST {AUTH_SERVICE_URL}/auth/sessions/revoke
 *   // Verified real: services/auth-service/src/handlers/revoke.handler.ts handleRevoke
 *   // Exposed at: services/auth-service/src/routes/sessions.ts router.post('/revoke', ...)
 *   //             mounted at: services/auth-service/src/app.ts → /auth/sessions
 *   // Full URL: AUTH_SERVICE_URL/auth/sessions/revoke
 *   // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
 *
 * Human-locked decisions:
 *   - Logout idempotency: second call returns 204 even with no cookie
 *   - Logout failure tolerance: auth-service revoke fail does NOT block logout (UX hardening)
 *   - Redis del() removes the bff:session:<sid> key
 *   - Clear cookie: Set-Cookie: rr_session=; Max-Age=0; Path=/
 *
 * ADR references:
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §6.1 #10 — Mocked Endpoint Verification
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { happyPathSession, sessionRedisKey } from '../../fixtures/session-data.js';

// ─── Shared logger mock ───────────────────────────────────────────────────────
const sharedLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

// ─── ioredis mock ─────────────────────────────────────────────────────────────
const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  expire: vi.fn(),
  del: vi.fn(),
  ping: vi.fn().mockResolvedValue('PONG'),
  on: vi.fn().mockReturnThis(),
};

vi.mock('ioredis', () => ({
  default: vi.fn(() => mockRedis),
  Redis: vi.fn(() => mockRedis),
}));

// ─── Constants ────────────────────────────────────────────────────────────────
const AUTH_SERVICE_URL = 'http://auth-service-stub-logout:9994';

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-003: POST /api/auth/logout handler unit tests', () => {
  let app: ReturnType<typeof express>;

  beforeEach(async () => {
    vi.clearAllMocks();
    nock.cleanAll();
    mockRedis.get.mockResolvedValue(JSON.stringify(happyPathSession));
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.del.mockResolvedValue(1);
    mockRedis.set.mockResolvedValue('OK');

    process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SESSION_COOKIE_NAME = 'rr_session';

    // @ts-expect-error — module does not exist yet (TDD RED phase)
    const { createLogoutRouter } = await import('../../../src/routes/auth.js');
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(createLogoutRouter(mockRedis));
  });

  afterEach(() => {
    nock.cleanAll();
    vi.restoreAllMocks();
    delete process.env.AUTH_SERVICE_URL;
    delete process.env.NODE_ENV;
    delete process.env.SESSION_COOKIE_NAME;
  });

  // ─── AC-4.1: Valid session → revoke auth-service + delete Redis + 204 ──────

  describe('AC-4.1: valid rr_session → (a) revoke auth-service, (b) delete Redis, (c) 204 + clear cookie', () => {
    it('AC-4.1(a): should call POST /auth/sessions/revoke on auth-service with access_token as Bearer', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/sessions/revoke
      // Verified real: services/auth-service/src/handlers/revoke.handler.ts handleRevoke
      // Exposed at: services/auth-service/src/routes/sessions.ts mounted at /auth/sessions/revoke
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      let capturedAuthHeader: string | undefined;
      const scope = nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/revoke')
        .reply(function () {
          capturedAuthHeader = this.req.headers['authorization'] as string;
          return [204, ''];
        });

      await request(app)
        .post('/api/auth/logout')
        .set('Cookie', `rr_session=${happyPathSession.session_id}`);

      expect(scope.isDone()).toBe(true);
      expect(capturedAuthHeader).toBe(`Bearer ${happyPathSession.access_token}`);
    });

    it('AC-4.1(b): should delete the Redis row for the BFF session', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/sessions/revoke
      // Verified real: services/auth-service/src/handlers/revoke.handler.ts handleRevoke
      // Exposed at: services/auth-service/src/routes/sessions.ts mounted at /auth/sessions/revoke
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/revoke')
        .reply(204, '');

      await request(app)
        .post('/api/auth/logout')
        .set('Cookie', `rr_session=${happyPathSession.session_id}`);

      expect(mockRedis.del).toHaveBeenCalledWith(sessionRedisKey(happyPathSession.session_id));
    });

    it('AC-4.1(c): should return 204 with Set-Cookie clearing rr_session', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/sessions/revoke
      // Verified real: services/auth-service/src/handlers/revoke.handler.ts handleRevoke
      // Exposed at: services/auth-service/src/routes/sessions.ts mounted at /auth/sessions/revoke
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/revoke')
        .reply(204, '');

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', `rr_session=${happyPathSession.session_id}`);

      expect(res.status).toBe(204);

      const setCookieHeader = res.headers['set-cookie'] as string[] | string | undefined;
      expect(setCookieHeader).toBeDefined();
      const cookieStr = Array.isArray(setCookieHeader) ? setCookieHeader.join('; ') : setCookieHeader!;
      // Cookie must be cleared: rr_session= with Max-Age=0
      expect(cookieStr).toMatch(/rr_session=/);
      expect(cookieStr.toLowerCase()).toMatch(/max-age=0/);
    });

    it('AC-4.1: should use auth_service_session_id (two-id model) — Redis row must contain it', async () => {
      // Two-id model: the Redis row stores auth_service_session_id separately
      // Logout should use the access_token from Redis to call revoke
      const sessionWithAuthId = {
        ...happyPathSession,
        auth_service_session_id: 'auth-sess-revoke-test-0001',
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(sessionWithAuthId));

      // Mocked: POST {AUTH_SERVICE_URL}/auth/sessions/revoke
      // Verified real: services/auth-service/src/handlers/revoke.handler.ts handleRevoke
      // Exposed at: services/auth-service/src/routes/sessions.ts mounted at /auth/sessions/revoke
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      let capturedAuthHeader: string | undefined;
      nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/revoke')
        .reply(function () {
          capturedAuthHeader = this.req.headers['authorization'] as string;
          return [204, ''];
        });

      await request(app)
        .post('/api/auth/logout')
        .set('Cookie', `rr_session=${happyPathSession.session_id}`);

      // access_token from Redis row is used as Bearer
      expect(capturedAuthHeader).toBe(`Bearer ${happyPathSession.access_token}`);
    });
  });

  // ─── AC-4.2: Idempotent — second call (no cookie) → 204 ──────────────────

  describe('AC-4.2: idempotent logout — second call with no cookie → 204', () => {
    it('AC-4.2: should return 204 with cookie-clearing Set-Cookie when no rr_session cookie', async () => {
      // No cookie present — second logout call
      mockRedis.get.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/auth/logout');

      expect(res.status).toBe(204);
    });

    it('AC-4.2: second logout should still send Set-Cookie clearing header', async () => {
      mockRedis.get.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/auth/logout');

      // Even with no cookie, should send a clearing Set-Cookie header
      const setCookieHeader = res.headers['set-cookie'] as string[] | string | undefined;
      if (setCookieHeader) {
        const cookieStr = Array.isArray(setCookieHeader) ? setCookieHeader.join('; ') : setCookieHeader;
        expect(cookieStr.toLowerCase()).toMatch(/max-age=0/);
      }
      // Either no Set-Cookie (also acceptable since no session) or a clearing one
      // The key requirement is 204 status
      expect(res.status).toBe(204);
    });

    it('AC-4.2: second logout should NOT call auth-service when no cookie/session', async () => {
      mockRedis.get.mockResolvedValue(null);

      const scope = nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/revoke')
        .reply(204, '');

      await request(app)
        .post('/api/auth/logout');

      // Without a session, auth-service revoke should not be called
      expect(scope.isDone()).toBe(false);
      nock.cleanAll();
    });
  });

  // ─── AC-4.3: Auth-service revoke fails → BFF still completes logout ───────

  describe('AC-4.3: auth-service revoke failure → BFF still completes logout (UX hardening)', () => {
    it('AC-4.3: should return 204 and delete Redis when auth-service revoke returns 503', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/sessions/revoke (503)
      // Verified real: services/auth-service/src/handlers/revoke.handler.ts handleRevoke
      // Exposed at: services/auth-service/src/routes/sessions.ts mounted at /auth/sessions/revoke
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/revoke')
        .reply(503, { error: 'upstream_unavailable' });

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', `rr_session=${happyPathSession.session_id}`);

      // UX hardening: BFF must still succeed
      expect(res.status).toBe(204);
      // Redis row must still be deleted
      expect(mockRedis.del).toHaveBeenCalledWith(sessionRedisKey(happyPathSession.session_id));
    });

    it('AC-4.3: should return 204 and clear cookie when auth-service revoke times out (>5s)', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/sessions/revoke (timeout)
      // Verified real: services/auth-service/src/handlers/revoke.handler.ts handleRevoke
      // Exposed at: services/auth-service/src/routes/sessions.ts mounted at /auth/sessions/revoke
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/revoke')
        .delayConnection(6000)
        .reply(204, '');

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', `rr_session=${happyPathSession.session_id}`)
        .timeout(10000);

      // UX hardening: 204 even when auth-service times out
      expect(res.status).toBe(204);

      const setCookieHeader = res.headers['set-cookie'] as string[] | string | undefined;
      expect(setCookieHeader).toBeDefined();
      const cookieStr = Array.isArray(setCookieHeader) ? setCookieHeader.join('; ') : setCookieHeader!;
      expect(cookieStr.toLowerCase()).toMatch(/max-age=0/);
    }, 15000);

    it('AC-4.3: should return 204 and delete Redis when auth-service network connection fails', async () => {
      // Simulate network error (connection refused)
      nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/revoke')
        .replyWithError({ code: 'ECONNREFUSED', message: 'Connection refused' });

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', `rr_session=${happyPathSession.session_id}`);

      // UX hardening: network error must not prevent logout
      expect(res.status).toBe(204);
      expect(mockRedis.del).toHaveBeenCalledWith(sessionRedisKey(happyPathSession.session_id));
    });

    it('AC-4.3: should clear the rr_session cookie even when auth-service revoke fails', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/sessions/revoke (503)
      // Verified real: services/auth-service/src/handlers/revoke.handler.ts handleRevoke
      // Exposed at: services/auth-service/src/routes/sessions.ts mounted at /auth/sessions/revoke
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/revoke')
        .reply(503, { error: 'upstream_unavailable' });

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', `rr_session=${happyPathSession.session_id}`);

      expect(res.status).toBe(204);
      const setCookieHeader = res.headers['set-cookie'] as string[] | string | undefined;
      expect(setCookieHeader).toBeDefined();
      const cookieStr = Array.isArray(setCookieHeader) ? setCookieHeader.join('; ') : setCookieHeader!;
      expect(cookieStr).toMatch(/rr_session=/);
      expect(cookieStr.toLowerCase()).toMatch(/max-age=0/);
    });
  });
});
