/**
 * Unit Tests: GET /api/auth/me handler (web-app-bff)
 *
 * Story   : RAILREPAY-WEB-BFF-003
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/routes/auth.ts  (exposing createMeRouter)
 *   src/handlers/me.handler.ts  (or inline in auth route)
 *
 * Failure reason expected: module-not-found or route 404.
 *
 * AC coverage map:
 *   AC-3.1: GET /api/auth/me with valid rr_session cookie → 200 { user_id, session_id }
 *            from req.session (BFF-side Redis resolve — NO auth-service call).
 *   AC-3.2: GET /api/auth/me with no cookie and no Bearer → 401 { error: 'unauthorized' }.
 *   AC-3.3: GET /api/auth/me with valid Bearer JWT (no cookie) → 200 { user_id, session_id }
 *            from JWT claims (Stage 2/3 native path). Cookie takes precedence when both present.
 *
 * Human-locked decisions:
 *   - /api/auth/me reads from req.session (populated by cookie-session or bearer-fallback middleware)
 *   - No auth-service round-trip for /api/auth/me (OQ-B lock)
 *   - Bearer and cookie are mutually exclusive — cookie wins (existing WEB-BFF-002 behavior)
 *
 * ADR references:
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §7 — Integration tests required (AC-3.3 bearer-vs-cookie also in integration test)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { SignJWT } from 'jose';
import { happyPathSession, sessionRedisKey } from '../../fixtures/session-data.js';
import { TEST_JWT_SECRET, TEST_JWT_ISSUER, TEST_JWT_AUDIENCE } from '../../fixtures/jwt-tokens.js';

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

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-003: GET /api/auth/me handler unit tests', () => {
  let app: ReturnType<typeof express>;
  let validBearerToken: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    nock.cleanAll();

    process.env.AUTH_SERVICE_URL = 'http://auth-service-stub-me:9995';
    process.env.NODE_ENV = 'test';
    process.env.SESSION_COOKIE_NAME = 'rr_session';
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    process.env.JWT_ISSUER = TEST_JWT_ISSUER;
    process.env.JWT_AUDIENCE = TEST_JWT_AUDIENCE;

    // Build a fresh valid Bearer token for each test
    const now = Math.floor(Date.now() / 1000);
    const secretBytes = new TextEncoder().encode(TEST_JWT_SECRET);
    validBearerToken = await new SignJWT({ sid: happyPathSession.session_id })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(happyPathSession.user_id)
      .setIssuer(TEST_JWT_ISSUER)
      .setAudience(TEST_JWT_AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(secretBytes);

    // @ts-expect-error — module does not exist yet (TDD RED phase)
    const { createMeRouter } = await import('../../../src/routes/auth.js');
    // @ts-expect-error — module does not exist yet (TDD RED phase)
    const { createCookieSessionMiddleware } = await import('../../../src/middleware/cookie-session.js');
    // @ts-expect-error — module does not exist yet (TDD RED phase)
    const { createBearerFallbackMiddleware } = await import('../../../src/middleware/bearer-fallback.js');

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(createCookieSessionMiddleware(mockRedis));
    app.use(createBearerFallbackMiddleware());
    app.use(createMeRouter(mockRedis));
  });

  afterEach(() => {
    nock.cleanAll();
    vi.restoreAllMocks();
    delete process.env.AUTH_SERVICE_URL;
    delete process.env.NODE_ENV;
    delete process.env.SESSION_COOKIE_NAME;
    delete process.env.JWT_SECRET;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
  });

  // ─── AC-3.1: Valid rr_session cookie → 200 { user_id, session_id } from Redis

  describe('AC-3.1: valid rr_session cookie → 200 { user_id, session_id } (no auth-service call)', () => {
    it('AC-3.1: should return 200 with user_id and session_id from req.session', async () => {
      // Stub Redis to return the happy-path session
      mockRedis.get.mockResolvedValue(JSON.stringify(happyPathSession));
      mockRedis.expire.mockResolvedValue(1);

      // Verify no auth-service call is made (nock would fail on unexpected request)
      const scope = nock('http://auth-service-stub-me:9995')
        .get(/.*/)
        .reply(500, { error: 'should_not_be_called' });

      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', `rr_session=${happyPathSession.session_id}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        user_id: happyPathSession.user_id,
        session_id: happyPathSession.session_id,
      });
      // Auth-service must NOT have been called
      expect(scope.isDone()).toBe(false);
      nock.cleanAll();
    });

    it('AC-3.1: should read from req.session populated by cookie-session middleware (Redis read)', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(happyPathSession));
      mockRedis.expire.mockResolvedValue(1);

      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', `rr_session=${happyPathSession.session_id}`);

      expect(res.status).toBe(200);
      // Redis get must have been called for session lookup
      expect(mockRedis.get).toHaveBeenCalledWith(sessionRedisKey(happyPathSession.session_id));
    });
  });

  // ─── AC-3.2: No cookie and no Bearer → 401 ───────────────────────────────

  describe('AC-3.2: no cookie and no Bearer → 401 { error: unauthorized }', () => {
    it('AC-3.2: should return 401 when no cookie and no Authorization header', async () => {
      mockRedis.get.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/auth/me');

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: 'unauthorized' });
    });

    it('AC-3.2: should return 401 when cookie is present but Redis row is missing', async () => {
      // Stale cookie scenario: cookie exists but Redis row not found
      mockRedis.get.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', 'rr_session=stale-session-id-not-in-redis');

      // Without a valid session, bearer-fallback will block (no Bearer either)
      expect(res.status).toBe(401);
    });
  });

  // ─── AC-3.3: Valid Bearer JWT (no cookie) → 200 { user_id, session_id } ───

  describe('AC-3.3: valid Bearer JWT (no cookie) → 200 { user_id, session_id } from JWT claims', () => {
    it('AC-3.3: should return 200 { user_id, session_id } from JWT claims when Bearer present', async () => {
      // No Redis call expected for Bearer path (cookie-session skips if no cookie)
      mockRedis.get.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${validBearerToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        user_id: happyPathSession.user_id,
        session_id: happyPathSession.session_id,
      });
    });

    it('AC-3.3: cookie takes precedence over Bearer when both present', async () => {
      // Cookie session present (different user from the Bearer token)
      const cookieSession = {
        ...happyPathSession,
        user_id: 'usr-cookie-wins-0001',
        session_id: 'sid-cookie-wins-0001',
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(cookieSession));
      mockRedis.expire.mockResolvedValue(1);

      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', `rr_session=${cookieSession.session_id}`)
        .set('Authorization', `Bearer ${validBearerToken}`);

      // Cookie wins — should return the cookie session's user_id, not the Bearer JWT's
      expect(res.status).toBe(200);
      expect(res.body.user_id).toBe('usr-cookie-wins-0001');
      // Must NOT return the Bearer token's user_id
      expect(res.body.user_id).not.toBe(happyPathSession.user_id);
    });

    it('AC-3.3: should return 401 for an expired Bearer token', async () => {
      const now = Math.floor(Date.now() / 1000);
      const secretBytes = new TextEncoder().encode(TEST_JWT_SECRET);
      const expiredToken = await new SignJWT({ sid: 'sid-expired' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('usr-expired')
        .setIssuer(TEST_JWT_ISSUER)
        .setAudience(TEST_JWT_AUDIENCE)
        .setIssuedAt(now - 120)
        .setExpirationTime(now - 60)
        .sign(secretBytes);

      mockRedis.get.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(res.status).toBe(401);
    });
  });
});
