/**
 * Unit Tests: Bearer fallback middleware
 *
 * Story   : RAILREPAY-WEB-BFF-002
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates src/middleware/bearer-fallback.ts.
 * Failure reason: "Cannot find module '../../src/middleware/bearer-fallback.js'"
 *
 * AC coverage map:
 *   AC-7: When no rr_session cookie present, parse Authorization: Bearer <jwt>.
 *         Verify locally with HS256 using JWT_SECRET.
 *         On valid: populate req.session = {user_id, session_id, source:'bearer'}, call next().
 *         On invalid/expired/missing: 401 {error:'unauthorized'}.
 *   AC-10: Cookie-session takes precedence over Bearer fallback (mutually exclusive paths).
 *
 * Uses REAL jose for token verification (per Quinn's spec: "real jose against fixture-signed tokens").
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  tokens,
  TEST_JWT_SECRET,
  TEST_JWT_ISSUER,
  TEST_JWT_AUDIENCE,
  TEST_USER_ID,
  TEST_SESSION_ID,
  type TokenSet,
} from '../fixtures/jwt-tokens.js';
import { happyPathSession } from '../fixtures/session-data.js';

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

const COOKIE_NAME = 'rr_session';

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-002: Bearer fallback middleware (unit)', () => {
  let tokenSet: TokenSet;

  beforeEach(async () => {
    vi.clearAllMocks();
    tokenSet = await tokens;

    // Set env vars for Bearer fallback middleware
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    process.env.JWT_ISSUER = TEST_JWT_ISSUER;
    process.env.JWT_AUDIENCE = TEST_JWT_AUDIENCE;
    process.env.SESSION_COOKIE_NAME = COOKIE_NAME;
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    delete process.env.SESSION_COOKIE_NAME;
    delete process.env.NODE_ENV;
    vi.restoreAllMocks();
  });

  // ─── AC-7: Valid Bearer token ──────────────────────────────────────────────

  describe('AC-7: valid Bearer JWT should populate req.session and call next()', () => {
    it('AC-7: valid HS256 token should result in 200 and req.session.user_id set', async () => {
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
    });

    it('AC-7: valid token should set req.session.session_id from JWT sid claim', async () => {
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

      await request(app)
        .get('/test')
        .set('Authorization', `Bearer ${tokenSet.valid}`);

      expect((capturedSession as Record<string, string>).session_id).toBe(TEST_SESSION_ID);
    });

    it('AC-7: valid token should set req.session.source = "bearer"', async () => {
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

      await request(app)
        .get('/test')
        .set('Authorization', `Bearer ${tokenSet.valid}`);

      expect((capturedSession as Record<string, string>).source).toBe('bearer');
    });
  });

  // ─── AC-7: Invalid tokens → 401 ──────────────────────────────────────────

  describe('AC-7: invalid/expired/tampered tokens should return 401 {error:"unauthorized"}', () => {
    it('AC-7: expired token should return 401', async () => {
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

    it('AC-7: token with wrong audience should return 401', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createBearerFallbackMiddleware } = await import('../../src/middleware/bearer-fallback.js');

      const app = express();
      app.use(cookieParser());
      app.use(createBearerFallbackMiddleware());
      app.get('/test', (_req, res) => res.json({ ok: true }));

      const res = await request(app)
        .get('/test')
        .set('Authorization', `Bearer ${tokenSet.wrongAudience}`);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized' });
    });

    it('AC-7: token with wrong issuer should return 401', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createBearerFallbackMiddleware } = await import('../../src/middleware/bearer-fallback.js');

      const app = express();
      app.use(cookieParser());
      app.use(createBearerFallbackMiddleware());
      app.get('/test', (_req, res) => res.json({ ok: true }));

      const res = await request(app)
        .get('/test')
        .set('Authorization', `Bearer ${tokenSet.wrongIssuer}`);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized' });
    });

    it('AC-7: tampered signature should return 401', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createBearerFallbackMiddleware } = await import('../../src/middleware/bearer-fallback.js');

      const app = express();
      app.use(cookieParser());
      app.use(createBearerFallbackMiddleware());
      app.get('/test', (_req, res) => res.json({ ok: true }));

      const res = await request(app)
        .get('/test')
        .set('Authorization', `Bearer ${tokenSet.tamperedSignature}`);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized' });
    });

    it('AC-7: no Authorization header should return 401', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createBearerFallbackMiddleware } = await import('../../src/middleware/bearer-fallback.js');

      const app = express();
      app.use(cookieParser());
      app.use(createBearerFallbackMiddleware());
      app.get('/test', (_req, res) => res.json({ ok: true }));

      const res = await request(app).get('/test');

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized' });
    });

    it('AC-7: malformed token (not 3 segments) should return 401', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createBearerFallbackMiddleware } = await import('../../src/middleware/bearer-fallback.js');

      const app = express();
      app.use(cookieParser());
      app.use(createBearerFallbackMiddleware());
      app.get('/test', (_req, res) => res.json({ ok: true }));

      const res = await request(app)
        .get('/test')
        .set('Authorization', 'Bearer not.a.valid.jwt.token');

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized' });
    });
  });

  // ─── AC-7 + AC-10: Cookie takes precedence over Bearer ───────────────────

  describe('AC-7/AC-10: rr_session cookie takes precedence over Bearer fallback', () => {
    it('AC-10: when rr_session cookie is present, Bearer fallback middleware should skip to next() without JWT verification', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createBearerFallbackMiddleware } = await import('../../src/middleware/bearer-fallback.js');

      // Redis has an active session for the cookie SID
      mockRedis.get.mockResolvedValue(JSON.stringify(happyPathSession));
      mockRedis.expire.mockResolvedValue(1);

      const app = express();
      app.use(cookieParser());
      app.use(createBearerFallbackMiddleware());

      let capturedSource: unknown;
      app.get('/test', (req, res) => {
        const session = (req as Record<string, unknown>).session as Record<string, unknown> | undefined;
        capturedSource = session?.source;
        res.json({ ok: true });
      });

      // Send both cookie AND an expired Bearer token — cookie should win
      const res = await request(app)
        .get('/test')
        .set('Cookie', `${COOKIE_NAME}=${happyPathSession.session_id}`)
        .set('Authorization', `Bearer ${tokenSet.expired}`);

      // Request must succeed (cookie path doesn't validate JWT)
      // The session.source must NOT be 'bearer' since cookie took precedence
      expect(res.status).toBe(200);
      expect(capturedSource).not.toBe('bearer');
    });
  });
});
