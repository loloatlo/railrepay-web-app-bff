/**
 * Unit Tests: auth-service client (refreshAccessToken helper)
 *
 * Story   : RAILREPAY-WEB-BFF-002
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates src/lib/auth-service-client.ts.
 * Failure reason: "Cannot find module '../../src/lib/auth-service-client.js'"
 *
 * AC coverage map:
 *   AC-8: refreshAccessToken(sid) helper:
 *         - Calls POST {AUTH_SERVICE_URL}/auth/sessions/refresh with current access_token as Bearer.
 *         - On 200 → updates Redis row with new access_token and refresh_at_iso.
 *         - On 401 → throws SessionExpiredError.
 *   AC-10: auth-service-client uses @railrepay/winston-logger (not console.log).
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
 *   CLAUDE.md §6.1 #10 — Mocked Endpoint Verification
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { happyPathSession, refreshedSession } from '../fixtures/session-data.js';

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

// ─── Test auth service URL ─────────────────────────────────────────────────────
const AUTH_SERVICE_URL = 'http://auth-service-stub:9999';

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-002: auth-service-client unit tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;

    // Ensure nock is clean
    nock.cleanAll();
  });

  afterEach(() => {
    delete process.env.AUTH_SERVICE_URL;
    nock.cleanAll();
    vi.restoreAllMocks();
  });

  // ─── AC-8: refreshAccessToken — 200 success path ─────────────────────────

  describe('AC-8: refreshAccessToken(sid) — calls POST /auth/sessions/refresh', () => {
    it('AC-8: should call POST AUTH_SERVICE_URL/auth/sessions/refresh with Bearer access_token', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { refreshAccessToken } = await import('../../src/lib/auth-service-client.js');

      // Mocked: POST {AUTH_SERVICE_URL}/auth/sessions/refresh
      // Verified real: services/auth-service/src/handlers/refresh.handler.ts handleRefresh
      // Exposed at: services/auth-service/src/routes/sessions.ts mounted at /auth/sessions/refresh
      // Last verified: 2026-04-26 (Jessie WEB-BFF-002 US-2)
      const scope = nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/refresh')
        .matchHeader('authorization', `Bearer ${happyPathSession.access_token}`)
        .reply(200, {
          access_token: refreshedSession.access_token,
          expires_in: 900,
        });

      mockRedis.get.mockResolvedValue(JSON.stringify(happyPathSession));
      mockRedis.expire.mockResolvedValue(1);
      mockRedis.set.mockResolvedValue('OK');

      await refreshAccessToken(mockRedis, happyPathSession.session_id);

      // nock intercept was consumed — confirms the HTTP call was made
      expect(scope.isDone()).toBe(true);
    });

    it('AC-8: on 200, should update Redis row with new access_token and refresh_at_iso', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { refreshAccessToken } = await import('../../src/lib/auth-service-client.js');

      const newAccessToken = 'eyJhbGciOiJIUzI1NiJ9.updated.token';

      // Mocked: POST {AUTH_SERVICE_URL}/auth/sessions/refresh
      // Verified real: services/auth-service/src/handlers/refresh.handler.ts handleRefresh
      // Exposed at: services/auth-service/src/routes/sessions.ts mounted at /auth/sessions/refresh
      // Last verified: 2026-04-26 (Jessie WEB-BFF-002 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/refresh')
        .reply(200, {
          access_token: newAccessToken,
          expires_in: 900,
        });

      mockRedis.get.mockResolvedValue(JSON.stringify(happyPathSession));
      mockRedis.expire.mockResolvedValue(1);
      mockRedis.set.mockResolvedValue('OK');

      await refreshAccessToken(mockRedis, happyPathSession.session_id);

      // Redis set() must be called to update the session with new token
      expect(mockRedis.set).toHaveBeenCalled();
      const [_key, value] = mockRedis.set.mock.calls[0];
      const parsed = JSON.parse(value);
      expect(parsed.access_token).toBe(newAccessToken);
      expect(parsed).toHaveProperty('refresh_at_iso');
    });

    it('AC-8: on 200, the updated Redis row should preserve user_id and session_id', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { refreshAccessToken } = await import('../../src/lib/auth-service-client.js');

      // Mocked: POST {AUTH_SERVICE_URL}/auth/sessions/refresh
      // Verified real: services/auth-service/src/handlers/refresh.handler.ts handleRefresh
      // Exposed at: services/auth-service/src/routes/sessions.ts mounted at /auth/sessions/refresh
      // Last verified: 2026-04-26 (Jessie WEB-BFF-002 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/refresh')
        .reply(200, {
          access_token: 'new-token',
          expires_in: 900,
        });

      mockRedis.get.mockResolvedValue(JSON.stringify(happyPathSession));
      mockRedis.expire.mockResolvedValue(1);
      mockRedis.set.mockResolvedValue('OK');

      await refreshAccessToken(mockRedis, happyPathSession.session_id);

      const [_key, value] = mockRedis.set.mock.calls[0];
      const parsed = JSON.parse(value);
      expect(parsed.user_id).toBe(happyPathSession.user_id);
      expect(parsed.session_id).toBe(happyPathSession.session_id);
    });
  });

  // ─── AC-8: refreshAccessToken — 401 → SessionExpiredError ────────────────

  describe('AC-8: refreshAccessToken on 401 → throws SessionExpiredError', () => {
    it('AC-8: should throw SessionExpiredError when auth-service returns 401', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { refreshAccessToken, SessionExpiredError } = await import('../../src/lib/auth-service-client.js');

      // Mocked: POST {AUTH_SERVICE_URL}/auth/sessions/refresh (401 response)
      // Verified real: services/auth-service/src/handlers/refresh.handler.ts
      // Exposed at: services/auth-service/src/routes/sessions.ts mounted at /auth/sessions/refresh
      // Last verified: 2026-04-26 (Jessie WEB-BFF-002 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/refresh')
        .reply(401, { error: 'unauthorized' });

      mockRedis.get.mockResolvedValue(JSON.stringify(happyPathSession));
      mockRedis.expire.mockResolvedValue(1);

      await expect(
        refreshAccessToken(mockRedis, happyPathSession.session_id)
      ).rejects.toThrow(SessionExpiredError);
    });

    it('AC-8: should NOT update Redis when auth-service returns 401', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { refreshAccessToken } = await import('../../src/lib/auth-service-client.js');

      // Mocked: POST {AUTH_SERVICE_URL}/auth/sessions/refresh (401 response)
      // Verified real: services/auth-service/src/handlers/refresh.handler.ts
      // Exposed at: services/auth-service/src/routes/sessions.ts mounted at /auth/sessions/refresh
      // Last verified: 2026-04-26 (Jessie WEB-BFF-002 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/refresh')
        .reply(401, { error: 'unauthorized' });

      mockRedis.get.mockResolvedValue(JSON.stringify(happyPathSession));
      mockRedis.expire.mockResolvedValue(1);

      try {
        await refreshAccessToken(mockRedis, happyPathSession.session_id);
      } catch {
        // expected
      }

      expect(mockRedis.set).not.toHaveBeenCalled();
    });
  });

  // ─── AC-8: refreshAccessToken — session not found in Redis ───────────────

  describe('AC-8: refreshAccessToken when session not in Redis', () => {
    it('AC-8: should throw when session row is not found in Redis', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { refreshAccessToken } = await import('../../src/lib/auth-service-client.js');

      mockRedis.get.mockResolvedValue(null);

      await expect(
        refreshAccessToken(mockRedis, 'sid-not-in-redis')
      ).rejects.toThrow();
    });
  });

  // ─── AC-10: Infrastructure wiring ────────────────────────────────────────

  describe('AC-10: auth-service-client uses @railrepay/winston-logger', () => {
    it('AC-10: should not call console.log or console.error', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { refreshAccessToken } = await import('../../src/lib/auth-service-client.js');

      nock(AUTH_SERVICE_URL)
        .post('/auth/sessions/refresh')
        .reply(200, { access_token: 'tok-log-test', expires_in: 900 });

      mockRedis.get.mockResolvedValue(JSON.stringify(happyPathSession));
      mockRedis.expire.mockResolvedValue(1);
      mockRedis.set.mockResolvedValue('OK');

      const consoleSpy = {
        log: vi.spyOn(console, 'log').mockImplementation(() => {}),
        error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      };

      await refreshAccessToken(mockRedis, happyPathSession.session_id);

      expect(consoleSpy.log).not.toHaveBeenCalled();
      expect(consoleSpy.error).not.toHaveBeenCalled();

      consoleSpy.log.mockRestore();
      consoleSpy.error.mockRestore();
    });
  });
});
