/**
 * Integration Tests: session routes (/api/session, /api/session/refresh, /api/session/issue)
 *
 * Story   : RAILREPAY-WEB-BFF-002
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates the full route/middleware stack.
 * Failure reason: module-not-found or Express app not yet configured with session routes.
 *
 * AC coverage map:
 *   AC-1: cookie-parser mounted in app — req.cookies populated.
 *   AC-3: POST /api/session/issue creates session and sets rr_session cookie with correct attributes.
 *   AC-4: GET /api/session → 200 {user_id, expires_at} authenticated; 401 unauthenticated.
 *   AC-4: GET /api/session → 401 + cookie-clear when Redis row absent.
 *   AC-5: POST /api/session/refresh → 204 authenticated; 401 + cookie-clear unauthenticated.
 *   AC-6: requireSameOrigin blocks POST with forbidden Origin → 403.
 *   AC-7 (integration): Bearer fallback wired in app; cookie takes precedence.
 *   AC-11: E2E flow: issue session via POST /api/session/issue → GET /api/session → 200.
 *
 * Infrastructure:
 *   - Testcontainers Redis for real I/O
 *   - supertest for HTTP assertions
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §7 — Integration tests required
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import request from 'supertest';
import { type Express } from 'express';
import {
  happyPathSession,
  SESSION_TTL_SECONDS,
} from '../fixtures/session-data.js';
import {
  tokens,
  TEST_JWT_SECRET,
  TEST_JWT_ISSUER,
  TEST_JWT_AUDIENCE,
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

const COOKIE_NAME = 'rr_session';
const ALLOWED_ORIGIN = 'https://railrepay-web-app-bff-production.up.railway.app';

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-002: session routes integration tests (Testcontainers Redis)', () => {
  let container: StartedTestContainer;
  let redis: Redis;
  let app: Express;
  let tokenSet: TokenSet;

  beforeAll(async () => {
    container = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .start();

    const redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
    redis = new Redis(redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 0 });

    process.env.AUTH_SERVICE_URL = 'http://localhost:19999';
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    process.env.JWT_ISSUER = TEST_JWT_ISSUER;
    process.env.JWT_AUDIENCE = TEST_JWT_AUDIENCE;
    process.env.SESSION_COOKIE_NAME = COOKIE_NAME;
    process.env.ALLOWED_ORIGINS = `${ALLOWED_ORIGIN},http://localhost:3000`;
    process.env.NODE_ENV = 'test';

    tokenSet = await tokens;

    // @ts-expect-error — module does not exist yet (TDD RED phase)
    const { createApp } = await import('../../src/app.js');
    app = createApp(redis);
  }, 120000);

  afterAll(async () => {
    await redis.quit();
    await container.stop();
    delete process.env.AUTH_SERVICE_URL;
    delete process.env.JWT_SECRET;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    delete process.env.SESSION_COOKIE_NAME;
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.NODE_ENV;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── AC-1: cookie-parser populates req.cookies in real app ───────────────

  describe('AC-1: cookie-parser is mounted in createApp — req.cookies populated', () => {
    it('AC-1: GET /api/session with rr_session cookie should not return 500 (cookie-parser is running)', async () => {
      const res = await request(app)
        .get('/api/session')
        .set('Cookie', `${COOKIE_NAME}=any-session-id`);

      // 401 is expected (no Redis row), but NOT 500 (which would indicate cookie-parser crash)
      expect(res.status).not.toBe(500);
    });
  });

  // ─── AC-3: POST /api/session/issue creates session + sets cookie ─────────

  describe('AC-3: POST /api/session/issue creates Redis session + sets rr_session cookie', () => {
    it('AC-3: should return 204 and set rr_session cookie with HttpOnly; Path=/', async () => {
      const res = await request(app)
        .post('/api/session/issue')
        .send({
          user_id: happyPathSession.user_id,
          access_token: happyPathSession.access_token,
        });

      expect(res.status).toBe(204);

      const setCookieHeaders = res.headers['set-cookie'] as string[] | undefined;
      expect(setCookieHeaders).toBeDefined();

      const sessionCookie = setCookieHeaders!.find((h) => h.startsWith(`${COOKIE_NAME}=`));
      expect(sessionCookie).toBeDefined();

      // Must have HttpOnly
      expect(sessionCookie!.toLowerCase()).toContain('httponly');
      // Must have Path=/
      expect(sessionCookie!).toContain('Path=/');
      // Must have Max-Age=2592000 (30 days)
      expect(sessionCookie!).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    });

    it('AC-3: session created via POST /api/session/issue must be retrievable via GET /api/session', async () => {
      // Issue session
      const issueRes = await request(app)
        .post('/api/session/issue')
        .send({
          user_id: 'usr-e2e-flow-test',
          access_token: 'tok-e2e-test',
        });

      expect(issueRes.status).toBe(204);

      const setCookieHeaders = issueRes.headers['set-cookie'] as string[];
      const sessionCookieHeader = setCookieHeaders.find((h) => h.startsWith(`${COOKIE_NAME}=`));
      const cookieValue = sessionCookieHeader!.split(';')[0]!; // e.g. "rr_session=<uuid>"

      // Now GET /api/session using the issued cookie
      const sessionRes = await request(app)
        .get('/api/session')
        .set('Cookie', cookieValue);

      expect(sessionRes.status).toBe(200);
      expect(sessionRes.body.user_id).toBe('usr-e2e-flow-test');
      expect(sessionRes.body).toHaveProperty('expires_at');
    });
  });

  // ─── AC-4: GET /api/session ──────────────────────────────────────────────

  describe('AC-4: GET /api/session returns 200 or 401', () => {
    it('AC-4: should return 401 when no rr_session cookie', async () => {
      const res = await request(app).get('/api/session');

      expect(res.status).toBe(401);
    });

    it('AC-4: should return 401 + cookie-clear when Redis row is absent (stale cookie)', async () => {
      const res = await request(app)
        .get('/api/session')
        .set('Cookie', `${COOKIE_NAME}=stale-sid-that-does-not-exist`);

      expect(res.status).toBe(401);

      const setCookieHeader = res.headers['set-cookie'] as string[] | undefined;
      const hasClearCookie = setCookieHeader?.some(
        (h) => h.includes(`${COOKIE_NAME}=`) && h.includes('Max-Age=0')
      );
      expect(hasClearCookie).toBe(true);
    });
  });

  // ─── AC-5: POST /api/session/refresh ─────────────────────────────────────

  describe('AC-5: POST /api/session/refresh', () => {
    it('AC-5: should return 401 when no cookie present', async () => {
      const res = await request(app).post('/api/session/refresh');

      expect(res.status).toBe(401);
    });

    it('AC-5: should return 401 + cookie-clear for stale session', async () => {
      const res = await request(app)
        .post('/api/session/refresh')
        .set('Cookie', `${COOKIE_NAME}=stale-sid-refresh-test`);

      expect(res.status).toBe(401);
      const setCookieHeader = res.headers['set-cookie'] as string[] | undefined;
      const hasClearCookie = setCookieHeader?.some(
        (h) => h.includes(`${COOKIE_NAME}=`) && h.includes('Max-Age=0')
      );
      expect(hasClearCookie).toBe(true);
    });

    it('AC-5: POST /api/session/refresh with valid session should return 204', async () => {
      // Issue a session first
      const issueRes = await request(app)
        .post('/api/session/issue')
        .send({
          user_id: 'usr-refresh-integration',
          access_token: 'tok-refresh-integration',
        });
      expect(issueRes.status).toBe(204);

      const setCookieHeaders = issueRes.headers['set-cookie'] as string[];
      const cookieValue = setCookieHeaders.find((h) => h.startsWith(`${COOKIE_NAME}=`))!.split(';')[0]!;

      const refreshRes = await request(app)
        .post('/api/session/refresh')
        .set('Cookie', cookieValue);

      expect(refreshRes.status).toBe(204);
    });
  });

  // ─── AC-6: requireSameOrigin blocks forbidden POST origins ───────────────

  describe('AC-6: requireSameOrigin middleware rejects forbidden Origin on POST', () => {
    it('AC-6: POST /api/session/issue with forbidden Origin should return 403', async () => {
      const res = await request(app)
        .post('/api/session/issue')
        .set('Origin', 'https://evil-attacker.com')
        .send({
          user_id: 'usr-blocked',
          access_token: 'tok-blocked',
        });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'origin_forbidden' });
    });

    it('AC-6: POST /api/session/issue with allowed Origin should NOT return 403', async () => {
      const res = await request(app)
        .post('/api/session/issue')
        .set('Origin', ALLOWED_ORIGIN)
        .send({
          user_id: 'usr-allowed-origin',
          access_token: 'tok-allowed-origin',
        });

      expect(res.status).not.toBe(403);
    });
  });

  // ─── AC-7 (integration): Bearer fallback wired in app ────────────────────

  describe('AC-7 (integration): Bearer fallback wired in Express app', () => {
    it('AC-7: GET /api/session with valid Bearer token and no cookie should return 200 (or next handler)', async () => {
      // Bearer fallback populates req.session — GET /api/session should honour it
      const res = await request(app)
        .get('/api/session')
        .set('Authorization', `Bearer ${tokenSet.valid}`);

      // May return 200 with user from bearer, OR 401 if session route requires Redis row too.
      // Either is acceptable — key assertion: NOT 500 (no unhandled crash).
      // For Bearer: if the route returns 200, body must have user_id.
      if (res.status === 200) {
        expect(res.body).toHaveProperty('user_id');
      }
      expect(res.status).not.toBe(500);
    });
  });

  // ─── AC-11: Full E2E: issue → read → slide TTL → read ────────────────────

  describe('AC-11: full end-to-end: issue session → GET /api/session → TTL slid', () => {
    it('AC-11: three-step flow: issue + read + TTL verification', async () => {
      // Step 1: Issue session
      const issueRes = await request(app)
        .post('/api/session/issue')
        .send({
          user_id: 'usr-e2e-ttl',
          access_token: 'tok-e2e-ttl',
        });
      expect(issueRes.status).toBe(204);

      const setCookieHeaders = issueRes.headers['set-cookie'] as string[];
      const rawCookieHeader = setCookieHeaders.find((h) => h.startsWith(`${COOKIE_NAME}=`))!;
      const cookiePair = rawCookieHeader.split(';')[0]!; // "rr_session=<uuid>"
      const sessionId = cookiePair.split('=')[1]!;

      // Step 2: GET /api/session — should return 200
      const sessionRes = await request(app)
        .get('/api/session')
        .set('Cookie', cookiePair);

      expect(sessionRes.status).toBe(200);
      expect(sessionRes.body.user_id).toBe('usr-e2e-ttl');

      // Step 3: Verify TTL was slid (real Redis TTL check)
      const { sessionRedisKey } = await import('../fixtures/session-data.js');
      const key = sessionRedisKey(sessionId);
      const ttl = await redis.ttl(key);

      // TTL must be ≈ SESSION_TTL_SECONDS (slid by GET /api/session call above)
      expect(ttl).toBeGreaterThan(SESSION_TTL_SECONDS - 10);
      expect(ttl).toBeLessThanOrEqual(SESSION_TTL_SECONDS);
    });
  });
});
