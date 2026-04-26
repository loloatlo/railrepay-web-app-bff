/**
 * Unit Tests: cookie-session middleware
 *
 * Story   : RAILREPAY-WEB-BFF-002
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates src/middleware/cookie-session.ts.
 * Failure reason: "Cannot find module '../../src/middleware/cookie-session.js'"
 *
 * AC coverage map:
 *   AC-1: cookie-parser middleware is mounted globally in app.ts; logs cookie presence (boolean),
 *         never the cookie value itself.
 *   AC-2: getSession reads bff:session:<sid>; null → 401 + cookie-clear.
 *   AC-4: GET /api/session returns 200 {user_id, expires_at} for authenticated request;
 *         401 + cookie-clear when Redis row absent.
 *   AC-5: POST /api/session/refresh extends TTL, returns 204; 401 + cookie-clear for unauthenticated.
 *   AC-10: middleware imports @railrepay/winston-logger; uses shared Redis instance via DI.
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { happyPathSession, sessionRedisKey, SESSION_TTL_SECONDS } from '../fixtures/session-data.js';

// ─── Shared logger mock (Guideline #11 in jessie-qa-tdd-enforcer.md) ──────────
const sharedLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

// ─── ioredis mock ──────────────────────────────────────────────────────────────
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

// ─── Session cookie name (locked by AC-9 / human decision) ───────────────────
const COOKIE_NAME = 'rr_session';

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-002: cookie-session middleware (unit)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SESSION_COOKIE_NAME = COOKIE_NAME;
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    delete process.env.SESSION_COOKIE_NAME;
    delete process.env.NODE_ENV;
    vi.restoreAllMocks();
  });

  // ─── AC-1: cookie-parser populates req.cookies ───────────────────────────

  describe('AC-1: cookie-parser middleware populates req.cookies', () => {
    it('AC-1: app with cookie-parser should see req.cookies populated from Cookie header', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createCookieSessionMiddleware } = await import('../../src/middleware/cookie-session.js');

      const app = express();
      app.use(cookieParser());
      app.use(createCookieSessionMiddleware(mockRedis));

      // Route that echoes req.cookies presence
      app.get('/test', (req, res) => {
        res.json({ hasCookie: COOKIE_NAME in req.cookies });
      });

      const res = await request(app)
        .get('/test')
        .set('Cookie', `${COOKIE_NAME}=some-session-id`);

      expect(res.status).toBe(200);
      expect(res.body.hasCookie).toBe(true);
    });

    it('AC-1: middleware should log cookie presence as boolean, never the cookie value', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createCookieSessionMiddleware } = await import('../../src/middleware/cookie-session.js');

      const sensitiveSessionId = 'super-secret-session-id-xyz';

      mockRedis.get.mockResolvedValue(JSON.stringify(happyPathSession));
      mockRedis.expire.mockResolvedValue(1);

      const app = express();
      app.use(cookieParser());
      app.use(createCookieSessionMiddleware(mockRedis));
      app.get('/test', (_req, res) => res.json({ ok: true }));

      await request(app)
        .get('/test')
        .set('Cookie', `${COOKIE_NAME}=${sensitiveSessionId}`);

      // No log call should contain the actual cookie value
      const allLogArgs = [
        ...sharedLogger.info.mock.calls,
        ...sharedLogger.warn.mock.calls,
        ...sharedLogger.error.mock.calls,
        ...sharedLogger.debug.mock.calls,
      ].map((call) => JSON.stringify(call));

      const leakedValue = allLogArgs.some((s) => s.includes(sensitiveSessionId));
      expect(leakedValue).toBe(false);
    });
  });

  // ─── AC-2: session lookup + TTL slide ────────────────────────────────────

  describe('AC-2: session middleware looks up session from Redis', () => {
    it('AC-2: valid rr_session cookie with active Redis row should call next() and attach req.session', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createCookieSessionMiddleware } = await import('../../src/middleware/cookie-session.js');

      mockRedis.get.mockResolvedValue(JSON.stringify(happyPathSession));
      mockRedis.expire.mockResolvedValue(1);

      const app = express();
      app.use(cookieParser());
      app.use(createCookieSessionMiddleware(mockRedis));

      let capturedSession: unknown;
      app.get('/test', (req, res) => {
        capturedSession = (req as Record<string, unknown>).session;
        res.json({ ok: true });
      });

      const res = await request(app)
        .get('/test')
        .set('Cookie', `${COOKIE_NAME}=${happyPathSession.session_id}`);

      expect(res.status).toBe(200);
      expect(capturedSession).toBeDefined();
      expect((capturedSession as Record<string, string>).user_id).toBe(happyPathSession.user_id);
    });

    it('AC-2: should slide TTL via EXPIRE on every successful authenticated read', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createCookieSessionMiddleware } = await import('../../src/middleware/cookie-session.js');

      mockRedis.get.mockResolvedValue(JSON.stringify(happyPathSession));
      mockRedis.expire.mockResolvedValue(1);

      const app = express();
      app.use(cookieParser());
      app.use(createCookieSessionMiddleware(mockRedis));
      app.get('/test', (_req, res) => res.json({ ok: true }));

      await request(app)
        .get('/test')
        .set('Cookie', `${COOKIE_NAME}=${happyPathSession.session_id}`);

      const expectedKey = sessionRedisKey(happyPathSession.session_id);
      expect(mockRedis.expire).toHaveBeenCalledWith(expectedKey, SESSION_TTL_SECONDS);
    });
  });

  // ─── AC-4: GET /api/session ──────────────────────────────────────────────

  describe('AC-4: GET /api/session returns 200 or 401', () => {
    it('AC-4: should return 200 {user_id, expires_at} for authenticated request with active session', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createSessionRouter } = await import('../../src/routes/session.js');

      mockRedis.get.mockResolvedValue(JSON.stringify(happyPathSession));
      mockRedis.expire.mockResolvedValue(1);

      const app = express();
      app.use(cookieParser());
      app.use(createSessionRouter(mockRedis));

      const res = await request(app)
        .get('/api/session')
        .set('Cookie', `${COOKIE_NAME}=${happyPathSession.session_id}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('user_id', happyPathSession.user_id);
      expect(res.body).toHaveProperty('expires_at');
    });

    it('AC-4: should return 401 when no rr_session cookie is present', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createSessionRouter } = await import('../../src/routes/session.js');

      const app = express();
      app.use(cookieParser());
      app.use(createSessionRouter(mockRedis));

      const res = await request(app).get('/api/session');

      expect(res.status).toBe(401);
    });

    it('AC-4: should return 401 + Set-Cookie clear when Redis row is absent', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createSessionRouter } = await import('../../src/routes/session.js');

      // Redis returns null — session row deleted or expired
      mockRedis.get.mockResolvedValue(null);

      const app = express();
      app.use(cookieParser());
      app.use(createSessionRouter(mockRedis));

      const res = await request(app)
        .get('/api/session')
        .set('Cookie', `${COOKIE_NAME}=stale-session-id`);

      expect(res.status).toBe(401);

      // Cookie-clear header must be present (AC-4: "response includes Set-Cookie: rr_session=; Max-Age=0; Path=/")
      const setCookieHeader = res.headers['set-cookie'] as string[] | undefined;
      expect(setCookieHeader).toBeDefined();
      const clearCookiePresent = setCookieHeader!.some(
        (h) => h.includes(`${COOKIE_NAME}=`) && h.includes('Max-Age=0')
      );
      expect(clearCookiePresent).toBe(true);
    });

    it('AC-4: should return 401 when cookie name does not match SESSION_COOKIE_NAME', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createSessionRouter } = await import('../../src/routes/session.js');

      const app = express();
      app.use(cookieParser());
      app.use(createSessionRouter(mockRedis));

      // Wrong cookie name
      const res = await request(app)
        .get('/api/session')
        .set('Cookie', `wrong_cookie_name=${happyPathSession.session_id}`);

      expect(res.status).toBe(401);
    });
  });

  // ─── AC-5: POST /api/session/refresh ─────────────────────────────────────

  describe('AC-5: POST /api/session/refresh extends TTL, returns 204', () => {
    it('AC-5: should return 204 and extend Redis TTL for authenticated request', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createSessionRouter } = await import('../../src/routes/session.js');

      mockRedis.get.mockResolvedValue(JSON.stringify(happyPathSession));
      mockRedis.expire.mockResolvedValue(1);

      const app = express();
      app.use(cookieParser());
      app.use(createSessionRouter(mockRedis));

      const res = await request(app)
        .post('/api/session/refresh')
        .set('Cookie', `${COOKIE_NAME}=${happyPathSession.session_id}`);

      expect(res.status).toBe(204);

      // EXPIRE must have been called to slide TTL
      const expectedKey = sessionRedisKey(happyPathSession.session_id);
      expect(mockRedis.expire).toHaveBeenCalledWith(expectedKey, SESSION_TTL_SECONDS);
    });

    it('AC-5: should return 401 + cookie-clear for unauthenticated POST /api/session/refresh', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createSessionRouter } = await import('../../src/routes/session.js');

      mockRedis.get.mockResolvedValue(null);

      const app = express();
      app.use(cookieParser());
      app.use(createSessionRouter(mockRedis));

      const res = await request(app)
        .post('/api/session/refresh')
        .set('Cookie', `${COOKIE_NAME}=missing-sid`);

      expect(res.status).toBe(401);

      const setCookieHeader = res.headers['set-cookie'] as string[] | undefined;
      expect(setCookieHeader).toBeDefined();
      const clearCookiePresent = setCookieHeader!.some(
        (h) => h.includes(`${COOKIE_NAME}=`) && h.includes('Max-Age=0')
      );
      expect(clearCookiePresent).toBe(true);
    });

    it('AC-5: should return 401 when no cookie present on POST /api/session/refresh', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createSessionRouter } = await import('../../src/routes/session.js');

      const app = express();
      app.use(cookieParser());
      app.use(createSessionRouter(mockRedis));

      const res = await request(app).post('/api/session/refresh');

      expect(res.status).toBe(401);
    });
  });

  // ─── AC-10: Infrastructure DI ────────────────────────────────────────────

  describe('AC-10: cookie-session middleware uses DI Redis instance', () => {
    it('AC-10: should use the Redis client passed via DI (not a new internal connection)', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createCookieSessionMiddleware } = await import('../../src/middleware/cookie-session.js');

      const injectedRedis = {
        ...mockRedis,
        get: vi.fn().mockResolvedValue(JSON.stringify(happyPathSession)),
        expire: vi.fn().mockResolvedValue(1),
      };

      const app = express();
      app.use(cookieParser());
      app.use(createCookieSessionMiddleware(injectedRedis));
      app.get('/test', (_req, res) => res.json({ ok: true }));

      await request(app)
        .get('/test')
        .set('Cookie', `${COOKIE_NAME}=${happyPathSession.session_id}`);

      // The injected instance's get() must be the one called
      expect(injectedRedis.get).toHaveBeenCalled();
    });
  });
});
