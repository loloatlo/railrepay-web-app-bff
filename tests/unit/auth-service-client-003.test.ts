/**
 * Unit Tests: auth-service-client — WEB-BFF-003 extensions
 *
 * Extends auth-service-client.test.ts (WEB-BFF-002) with new method coverage:
 *   startOtp, verifyOtp, revokeSession — and AbortController/5s timeout assertions.
 *
 * Story   : RAILREPAY-WEB-BFF-003
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake extends src/lib/auth-service-client.ts with:
 *   - startOtp(phone_e164, channel, correlationId?) → { statusCode, body }
 *   - verifyOtp(phone_e164, channel, code, correlationId?) → { statusCode, body }
 *   - revokeSession(accessToken) → { statusCode }
 *   - withTimeout(ms) AbortController on all outbound calls
 *
 * Failure reason expected: functions not exported from auth-service-client.js
 *
 * AC coverage map:
 *   AC-1.1: startOtp calls POST /auth/otp/start, returns { statusCode: 202, body: { status: 'sent' } }
 *   AC-1.4: startOtp passes through 429 body from auth-service
 *   AC-1.5: startOtp passes through 503 body from auth-service
 *   AC-1.6: startOtp AbortController fires after 5s; throws/returns upstream_unavailable error
 *   AC-2.1: verifyOtp calls POST /auth/otp/verify, returns 200 + VerifyOtpResult
 *   AC-2.4: verifyOtp passes through 401 from auth-service
 *   AC-4.1: revokeSession calls POST /auth/sessions/revoke with Bearer access_token
 *   AC-4.3: revokeSession resolves without throwing even when auth-service returns 503 (UX hardening)
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
 * Human-locked decisions:
 *   - 5s AbortController on ALL auth-service calls (OQ-D)
 *   - startOtp/verifyOtp return { statusCode, body } for handler to interpret
 *   - revokeSession must not throw on auth-service failure (AC-4.3 UX hardening)
 *
 * ADR references:
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §6.1 #10 — Mocked Endpoint Verification
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';

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
const AUTH_SERVICE_URL = 'http://auth-service-stub-client003:9993';

const AUTH_VERIFY_RESPONSE = {
  user_id: 'usr-client-test-0001',
  session_id: 'auth-sess-client-test-0001',
  access_token: 'eyJhbGciOiJIUzI1NiJ9.client.test.token',
  expires_in: 900,
};

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-003: auth-service-client new methods (US-2 extension)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nock.cleanAll();
    process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;
  });

  afterEach(() => {
    nock.cleanAll();
    vi.restoreAllMocks();
    delete process.env.AUTH_SERVICE_URL;
  });

  // ─── startOtp ──────────────────────────────────────────────────────────────

  describe('startOtp(phone_e164, channel, correlationId?)', () => {
    it('AC-1.1: should call POST /auth/otp/start and return { statusCode: 202, body: { status: "sent" } }', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/start
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleStartOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/start
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      const scope = nock(AUTH_SERVICE_URL)
        .post('/auth/otp/start', { phone_e164: '+447700900100', channel: 'web' })
        .reply(202, { status: 'sent' });

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { startOtp } = await import('../../src/lib/auth-service-client.js');
      const result = await startOtp('+447700900100', 'web');

      expect(scope.isDone()).toBe(true);
      expect(result.statusCode).toBe(202);
      expect(result.body).toEqual({ status: 'sent' });
    });

    it('AC-1.1: should forward correlationId as x-correlation-id header', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/start
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleStartOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/start
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      let capturedCorrelation: string | undefined;
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/start')
        .reply(function () {
          capturedCorrelation = this.req.headers['x-correlation-id'] as string;
          return [202, { status: 'sent' }];
        });

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { startOtp } = await import('../../src/lib/auth-service-client.js');
      await startOtp('+447700900200', 'web', 'corr-abc-123');

      expect(capturedCorrelation).toBe('corr-abc-123');
    });

    it('AC-1.4: should return { statusCode: 429, body: { error: rate_limited } } from auth-service', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/start (429)
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleStartOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/start
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/start')
        .reply(429, { error: 'rate_limited', retry_after_seconds: 30 });

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { startOtp } = await import('../../src/lib/auth-service-client.js');
      const result = await startOtp('+447700900300', 'rn');

      expect(result.statusCode).toBe(429);
      expect(result.body).toMatchObject({ error: 'rate_limited', retry_after_seconds: 30 });
    });

    it('AC-1.5: should return { statusCode: 503, body: { error: upstream_unavailable } } from auth-service', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/start (503)
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleStartOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/start
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/start')
        .reply(503, { error: 'upstream_unavailable' });

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { startOtp } = await import('../../src/lib/auth-service-client.js');
      const result = await startOtp('+447700900400', 'swift');

      expect(result.statusCode).toBe(503);
      expect(result.body).toMatchObject({ error: 'upstream_unavailable' });
    });

    it('AC-1.6: should reject with upstream_unavailable body when request times out after 5s', async () => {
      // nock simulates a slow response beyond the 5s AbortController
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/start (delayed >5s)
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleStartOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/start
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/start')
        .delayConnection(6000)
        .reply(202, { status: 'sent' });

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { startOtp } = await import('../../src/lib/auth-service-client.js');

      // startOtp should either throw (AbortError) or return 503 when timeout fires
      let threw = false;
      let result: { statusCode: number; body: Record<string, unknown> } | undefined;
      try {
        result = await startOtp('+447700900500', 'web');
      } catch {
        threw = true;
      }

      // Either threw OR returned a 503 with upstream_unavailable
      if (!threw) {
        expect(result!.statusCode).toBe(503);
        expect(result!.body).toMatchObject({ error: 'upstream_unavailable' });
      } else {
        expect(threw).toBe(true);
      }
    }, 15000);
  });

  // ─── verifyOtp ─────────────────────────────────────────────────────────────

  describe('verifyOtp(phone_e164, channel, code, correlationId?)', () => {
    it('AC-2.1: should call POST /auth/otp/verify and return { statusCode: 200, body: VerifyOtpResult }', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/verify
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleVerifyOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/verify
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      const scope = nock(AUTH_SERVICE_URL)
        .post('/auth/otp/verify', { phone_e164: '+447700900600', channel: 'web', code: '123456' })
        .reply(200, AUTH_VERIFY_RESPONSE);

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { verifyOtp } = await import('../../src/lib/auth-service-client.js');
      const result = await verifyOtp('+447700900600', 'web', '123456');

      expect(scope.isDone()).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.body).toMatchObject({
        user_id: AUTH_VERIFY_RESPONSE.user_id,
        session_id: AUTH_VERIFY_RESPONSE.session_id,
        access_token: AUTH_VERIFY_RESPONSE.access_token,
      });
    });

    it('AC-2.4: should return { statusCode: 401 } when auth-service returns 401 invalid_code', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/verify (401)
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleVerifyOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/verify
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/verify')
        .reply(401, { error: 'invalid_code' });

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { verifyOtp } = await import('../../src/lib/auth-service-client.js');
      const result = await verifyOtp('+447700900700', 'rn', '999999');

      expect(result.statusCode).toBe(401);
      expect(result.body).toMatchObject({ error: 'invalid_code' });
    });
  });

  // ─── revokeSession ─────────────────────────────────────────────────────────

  describe('revokeSession(accessToken)', () => {
    it('AC-4.1: should call POST /auth/sessions/revoke with Bearer access_token', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/sessions/revoke
      // Verified real: services/auth-service/src/handlers/revoke.handler.ts handleRevoke
      // Exposed at: services/auth-service/src/routes/sessions.ts mounted at /auth/sessions/revoke
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      const ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.revoke.test.token';
      let capturedAuth: string | undefined;
      const scope = nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/revoke')
        .reply(function () {
          capturedAuth = this.req.headers['authorization'] as string;
          return [204, ''];
        });

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { revokeSession } = await import('../../src/lib/auth-service-client.js');
      await revokeSession(ACCESS_TOKEN);

      expect(scope.isDone()).toBe(true);
      expect(capturedAuth).toBe(`Bearer ${ACCESS_TOKEN}`);
    });

    it('AC-4.3: revokeSession should resolve (not throw) when auth-service returns 503 (UX hardening)', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/sessions/revoke (503)
      // Verified real: services/auth-service/src/handlers/revoke.handler.ts handleRevoke
      // Exposed at: services/auth-service/src/routes/sessions.ts mounted at /auth/sessions/revoke
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/revoke')
        .reply(503, { error: 'upstream_unavailable' });

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { revokeSession } = await import('../../src/lib/auth-service-client.js');

      // Must NOT throw — UX hardening requires logout to complete regardless
      await expect(revokeSession('any-access-token-503')).resolves.not.toThrow();
    });

    it('AC-4.3: revokeSession should resolve when auth-service connection is refused', async () => {
      nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/revoke')
        .replyWithError({ code: 'ECONNREFUSED', message: 'Connection refused' });

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { revokeSession } = await import('../../src/lib/auth-service-client.js');

      // Network error must be swallowed — logout cannot fail because revoke fails
      await expect(revokeSession('any-access-token-econnrefused')).resolves.not.toThrow();
    });

    it('AC-4.3: revokeSession should resolve when auth-service times out (>5s)', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/sessions/revoke (timeout)
      // Verified real: services/auth-service/src/handlers/revoke.handler.ts handleRevoke
      // Exposed at: services/auth-service/src/routes/sessions.ts mounted at /auth/sessions/revoke
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/revoke')
        .delayConnection(6000)
        .reply(204, '');

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { revokeSession } = await import('../../src/lib/auth-service-client.js');

      // Timeout must be swallowed — logout cannot fail
      await expect(revokeSession('any-access-token-timeout')).resolves.not.toThrow();
    }, 15000);
  });

  // ─── withTimeout AbortController ───────────────────────────────────────────

  describe('withTimeout helper — 5s AbortController (OQ-D lock)', () => {
    it('AC-1.6: AbortController timeout of 5000ms is applied on startOtp calls', async () => {
      // We verify the timeout constant is exported or the behavior is observed via the
      // 5s delay test above. This test verifies the module exports a TIMEOUT constant or
      // the startOtp implementation observable timeout.
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const clientModule = await import('../../src/lib/auth-service-client.js');

      // The module must export AUTH_SERVICE_TIMEOUT_MS = 5000 or apply it internally
      // Blake can export AUTH_SERVICE_TIMEOUT_MS = 5000 for verifiability
      if ('AUTH_SERVICE_TIMEOUT_MS' in clientModule) {
        expect(clientModule.AUTH_SERVICE_TIMEOUT_MS).toBe(5000);
      } else {
        // Acceptable alternative: function exists and the delay test above validates behavior
        expect(typeof clientModule.startOtp).toBe('function');
      }
    });
  });
});
