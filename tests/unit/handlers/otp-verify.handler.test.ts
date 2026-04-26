/**
 * Unit Tests: POST /api/auth/otp/verify handler (web-app-bff)
 *
 * Story   : RAILREPAY-WEB-BFF-003
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/handlers/otp-verify.handler.ts  (or src/routes/auth.ts)
 *   Blake also extends session-store.ts to include auth_service_session_id in SessionData
 *
 * Failure reason expected: module-not-found or route 404.
 *
 * AC coverage map:
 *   AC-2.1: 200 { user_id, expires_at } + Set-Cookie: rr_session=<bff-sid>; HttpOnly; Secure;
 *            SameSite=Lax; Max-Age=2592000; Path=/.
 *            Body does NOT include auth-service session_id or access_token.
 *   AC-2.2: BFF Redis row at bff:session:<bff-sid> contains auth-service access_token AND session_id.
 *   AC-2.3: code too short/too long → 400 { error: invalid_request, details: code } NO auth-service call.
 *   AC-2.4: auth-service returns 401 { error: invalid_code } → BFF returns 401; NO session cookie, NO Redis write.
 *
 * Mocked HTTP (nock):
 *   // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/verify
 *   // Verified real: services/auth-service/src/handlers/otp.handler.ts handleVerifyOtp
 *   // Exposed at: services/auth-service/src/routes/otp.ts router.post('/otp/verify', ...)
 *   //             mounted at: services/auth-service/src/app.ts → /auth
 *   // Full URL: AUTH_SERVICE_URL/auth/otp/verify
 *   // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
 *
 * auth-service verify response shape (verified from otp.service.ts VerifyOtpResult):
 *   { user_id: string, session_id: string, access_token: string, expires_in: number }
 *
 * Human-locked decisions:
 *   - Two-id model: BFF UUID for cookie; Redis row stores BOTH BFF UUID AND auth-service session_id
 *   - Code length: 4-10 digit numeric (matches Twilio Verify range)
 *   - Cookie attrs: HttpOnly, Secure (production), SameSite=Lax, Max-Age=2592000, Path=/
 *   - Body shape: { user_id, expires_at } — no auth tokens exposed
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
const AUTH_SERVICE_URL = 'http://auth-service-stub-verify:9996';

/** Successful auth-service verify response (matches VerifyOtpResult from otp.service.ts) */
const AUTH_VERIFY_SUCCESS_RESPONSE = {
  user_id: 'usr-00000042-aaaa-bbbb-cccc-000000000042',
  session_id: 'auth-sess-00000042-1111-2222-3333-000000000042',
  access_token: 'eyJhbGciOiJIUzI1NiJ9.verify.success.token',
  expires_in: 900,
};

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-003: POST /api/auth/otp/verify handler unit tests', () => {
  let app: ReturnType<typeof express>;

  beforeEach(async () => {
    vi.clearAllMocks();
    nock.cleanAll();
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.get.mockResolvedValue(null);
    mockRedis.expire.mockResolvedValue(1);

    process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SESSION_COOKIE_NAME = 'rr_session';

    // @ts-expect-error — module does not exist yet (TDD RED phase)
    const { createOtpVerifyRouter } = await import('../../../src/routes/auth.js');
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(createOtpVerifyRouter(mockRedis));
  });

  afterEach(() => {
    nock.cleanAll();
    vi.restoreAllMocks();
    delete process.env.AUTH_SERVICE_URL;
    delete process.env.NODE_ENV;
    delete process.env.SESSION_COOKIE_NAME;
  });

  // ─── AC-2.1: Success → 200 { user_id, expires_at } + Set-Cookie ──────────

  describe('AC-2.1: auth-service 200 → 200 { user_id, expires_at } + rr_session cookie', () => {
    it('AC-2.1: should return 200 with { user_id, expires_at } on auth-service success', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/verify
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleVerifyOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/verify
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/verify')
        .reply(200, AUTH_VERIFY_SUCCESS_RESPONSE);

      const res = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone_e164: '+447700900123', channel: 'web', code: '123456' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('user_id', AUTH_VERIFY_SUCCESS_RESPONSE.user_id);
      expect(res.body).toHaveProperty('expires_at');
      // Body must NOT expose auth-service internals
      expect(res.body).not.toHaveProperty('access_token');
      expect(res.body).not.toHaveProperty('session_id');
    });

    it('AC-2.1: response body must not include auth-service session_id or access_token', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/verify
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleVerifyOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/verify
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/verify')
        .reply(200, AUTH_VERIFY_SUCCESS_RESPONSE);

      const res = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone_e164: '+447700900123', channel: 'web', code: '1234' });

      expect(Object.keys(res.body)).not.toContain('access_token');
      expect(Object.keys(res.body)).not.toContain('session_id');
    });

    it('AC-2.1: should set rr_session cookie with HttpOnly and SameSite=Lax', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/verify
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleVerifyOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/verify
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/verify')
        .reply(200, AUTH_VERIFY_SUCCESS_RESPONSE);

      const res = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone_e164: '+447700900123', channel: 'web', code: '654321' });

      const setCookieHeader = res.headers['set-cookie'] as string[] | string | undefined;
      expect(setCookieHeader).toBeDefined();

      const cookieStr = Array.isArray(setCookieHeader) ? setCookieHeader.join('; ') : setCookieHeader!;
      expect(cookieStr).toMatch(/rr_session=/);
      expect(cookieStr.toLowerCase()).toMatch(/httponly/);
      expect(cookieStr.toLowerCase()).toMatch(/samesite=lax/);
      expect(cookieStr.toLowerCase()).toMatch(/max-age=2592000/);
      expect(cookieStr.toLowerCase()).toMatch(/path=\//);
    });

    it('AC-2.1: cookie value should be a BFF-generated UUID (not auth-service session_id)', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/verify
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleVerifyOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/verify
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/verify')
        .reply(200, AUTH_VERIFY_SUCCESS_RESPONSE);

      const res = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone_e164: '+12025551234', channel: 'rn', code: '112233' });

      const setCookieHeader = res.headers['set-cookie'] as string[] | undefined;
      expect(setCookieHeader).toBeDefined();
      const cookieMatch = setCookieHeader![0]!.match(/rr_session=([^;]+)/);
      expect(cookieMatch).not.toBeNull();
      const bffSid = cookieMatch![1];
      // BFF SID must NOT equal auth-service session_id
      expect(bffSid).not.toBe(AUTH_VERIFY_SUCCESS_RESPONSE.session_id);
      // Should look like a UUID v4
      expect(bffSid).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  // ─── AC-2.2: Redis row contains auth access_token AND auth session_id ──────

  describe('AC-2.2: Redis row at bff:session:<bff-sid> stores auth access_token AND auth session_id', () => {
    it('AC-2.2: Redis set() should store auth_service access_token in the session row', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/verify
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleVerifyOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/verify
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/verify')
        .reply(200, AUTH_VERIFY_SUCCESS_RESPONSE);

      await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone_e164: '+447700900123', channel: 'web', code: '987654' });

      // Redis set() must have been called to persist the session
      expect(mockRedis.set).toHaveBeenCalled();
      const setCall = mockRedis.set.mock.calls[0];
      const sessionJson = JSON.parse(setCall[1] as string) as Record<string, unknown>;

      // AC-2.2: must include auth-service access_token
      expect(sessionJson).toHaveProperty('access_token', AUTH_VERIFY_SUCCESS_RESPONSE.access_token);
    });

    it('AC-2.2: Redis row must include auth_service_session_id (two-id model)', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/verify
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleVerifyOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/verify
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/verify')
        .reply(200, AUTH_VERIFY_SUCCESS_RESPONSE);

      await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone_e164: '+447700900123', channel: 'web', code: '246810' });

      expect(mockRedis.set).toHaveBeenCalled();
      const setCall = mockRedis.set.mock.calls[0];
      const sessionJson = JSON.parse(setCall[1] as string) as Record<string, unknown>;

      // AC-2.2: must include auth-service session_id stored as auth_service_session_id
      expect(sessionJson).toHaveProperty(
        'auth_service_session_id',
        AUTH_VERIFY_SUCCESS_RESPONSE.session_id
      );
    });

    it('AC-2.2: Redis key should be bff:session:<bff-uuid>', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/verify
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleVerifyOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/verify
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/verify')
        .reply(200, AUTH_VERIFY_SUCCESS_RESPONSE);

      await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone_e164: '+447700900456', channel: 'swift', code: '135791' });

      expect(mockRedis.set).toHaveBeenCalled();
      const redisKey = mockRedis.set.mock.calls[0][0] as string;
      expect(redisKey).toMatch(/^bff:session:[0-9a-f-]{36}$/);
    });

    it('AC-2.2: Redis set should use EX 2592000', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/verify
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleVerifyOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/verify
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/verify')
        .reply(200, AUTH_VERIFY_SUCCESS_RESPONSE);

      await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone_e164: '+447700900789', channel: 'web', code: '102030' });

      expect(mockRedis.set).toHaveBeenCalled();
      const setArgs = mockRedis.set.mock.calls[0];
      // Expects: redis.set(key, value, 'EX', 2592000)
      expect(setArgs).toContain('EX');
      expect(setArgs).toContain(2592000);
    });
  });

  // ─── AC-2.3: code validation — too short → 400 without calling auth-service

  describe('AC-2.3: invalid code → 400 { error: invalid_request, details: code } — no auth-service call', () => {
    it('AC-2.3: should return 400 for code shorter than 4 digits ("12")', async () => {
      const scope = nock(AUTH_SERVICE_URL).post('/auth/otp/verify').reply(200, AUTH_VERIFY_SUCCESS_RESPONSE);

      const res = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone_e164: '+447700900123', channel: 'web', code: '12' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid_request', details: 'code' });
      expect(scope.isDone()).toBe(false);
      nock.cleanAll();
    });

    it('AC-2.3: should return 400 for code longer than 10 digits', async () => {
      const scope = nock(AUTH_SERVICE_URL).post('/auth/otp/verify').reply(200, AUTH_VERIFY_SUCCESS_RESPONSE);

      const res = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone_e164: '+447700900123', channel: 'web', code: '12345678901' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid_request', details: 'code' });
      expect(scope.isDone()).toBe(false);
      nock.cleanAll();
    });

    it('AC-2.3: should return 400 for missing code', async () => {
      const scope = nock(AUTH_SERVICE_URL).post('/auth/otp/verify').reply(200, AUTH_VERIFY_SUCCESS_RESPONSE);

      const res = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone_e164: '+447700900123', channel: 'web' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid_request', details: 'code' });
      expect(scope.isDone()).toBe(false);
      nock.cleanAll();
    });

    it('AC-2.3: should return 400 for non-numeric code ("abcd")', async () => {
      const scope = nock(AUTH_SERVICE_URL).post('/auth/otp/verify').reply(200, AUTH_VERIFY_SUCCESS_RESPONSE);

      const res = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone_e164: '+447700900123', channel: 'web', code: 'abcd' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid_request', details: 'code' });
      expect(scope.isDone()).toBe(false);
      nock.cleanAll();
    });

    it('AC-2.3: should accept minimum-valid code of 4 digits', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/verify
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleVerifyOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/verify
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/verify')
        .reply(200, AUTH_VERIFY_SUCCESS_RESPONSE);

      const res = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone_e164: '+447700900123', channel: 'web', code: '1234' });

      // Should pass BFF validation and call auth-service (not a 400)
      expect(res.status).not.toBe(400);
    });

    it('AC-2.3: should accept maximum-valid code of 10 digits', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/verify
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleVerifyOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/verify
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/verify')
        .reply(200, AUTH_VERIFY_SUCCESS_RESPONSE);

      const res = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone_e164: '+447700900123', channel: 'web', code: '1234567890' });

      expect(res.status).not.toBe(400);
    });
  });

  // ─── AC-2.4: auth-service 401 → 401; NO cookie, NO Redis write ─────────────

  describe('AC-2.4: auth-service 401 invalid_code → BFF returns 401; no session minted', () => {
    it('AC-2.4: should return 401 { error: invalid_code } when auth-service returns 401', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/verify (401)
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleVerifyOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/verify
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/verify')
        .reply(401, { error: 'invalid_code' });

      const res = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone_e164: '+447700900123', channel: 'web', code: '999999' });

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: 'invalid_code' });
    });

    it('AC-2.4: should NOT set rr_session cookie when auth-service returns 401', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/verify (401)
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleVerifyOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/verify
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/verify')
        .reply(401, { error: 'invalid_code' });

      const res = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone_e164: '+447700900456', channel: 'rn', code: '888888' });

      const setCookieHeader = res.headers['set-cookie'] as string[] | undefined;
      // No rr_session cookie should be set
      if (setCookieHeader) {
        const hasCookie = setCookieHeader.some((c) => c.startsWith('rr_session=') && !c.includes('Max-Age=0'));
        expect(hasCookie).toBe(false);
      } else {
        expect(setCookieHeader).toBeUndefined();
      }
    });

    it('AC-2.4: should NOT write to Redis when auth-service returns 401', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/verify (401)
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleVerifyOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/verify
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/verify')
        .reply(401, { error: 'invalid_code' });

      await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone_e164: '+447700900789', channel: 'swift', code: '777777' });

      expect(mockRedis.set).not.toHaveBeenCalled();
    });
  });
});
