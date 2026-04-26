/**
 * Unit Tests: POST /api/auth/otp/start handler (web-app-bff)
 *
 * Story   : RAILREPAY-WEB-BFF-003
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/handlers/otp-start.handler.ts
 *   src/routes/auth.ts   (mounts the route)
 *
 * Failure reason expected: "Cannot find module '../../src/handlers/otp-start.handler.js'"
 * or supertest 404 if routes not mounted.
 *
 * AC coverage map:
 *   AC-1.1: 202 { status: 'sent' } when auth-service returns 202.
 *   AC-1.2: 400 { error: 'invalid_request', details: 'phone_e164' } without calling auth-service.
 *   AC-1.3: 400 { error: 'invalid_request', details: 'channel' } for channel='whatsapp'.
 *   AC-1.4: Pass-through 429 { error: 'rate_limited', retry_after_seconds: N } from auth-service.
 *   AC-1.5: Pass-through 503 { error: 'upstream_unavailable' } from auth-service.
 *   AC-1.6: 503 { error: 'upstream_unavailable' } when auth-service call times out (>5s AbortController).
 *
 * Mocked HTTP (nock intercepting Node http module — same pattern as WEB-BFF-002):
 *   // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/start
 *   // Verified real: services/auth-service/src/handlers/otp.handler.ts handleStartOtp
 *   // Exposed at: services/auth-service/src/routes/otp.ts router.post('/otp/start', ...)
 *   //             mounted at: services/auth-service/src/app.ts → /auth
 *   // Full URL: AUTH_SERVICE_URL/auth/otp/start
 *   // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
 *
 * Human-locked decisions applied in tests:
 *   - Phone regex: /^\+[1-9]\d{1,14}$/
 *   - BFF channel enum: 'web' | 'rn' | 'swift' (NO 'whatsapp')
 *   - Timeout: 5s AbortController
 *   - Error shape: { error, message?, details? }
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §6.1 #10 — Mocked Endpoint Verification
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import request from 'supertest';
import express from 'express';

// ─── Shared logger mock (CLAUDE.md §6.1 #11) ─────────────────────────────────
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
const AUTH_SERVICE_URL = 'http://auth-service-stub-003:9997';

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-003: POST /api/auth/otp/start handler unit tests', () => {
  let app: ReturnType<typeof express>;

  beforeEach(async () => {
    vi.clearAllMocks();
    nock.cleanAll();

    process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;
    process.env.NODE_ENV = 'test';

    // @ts-expect-error — module does not exist yet (TDD RED phase)
    const { createOtpStartRouter } = await import('../../../src/routes/auth.js');
    app = express();
    app.use(express.json());
    app.use(createOtpStartRouter(mockRedis));
  });

  afterEach(() => {
    nock.cleanAll();
    vi.restoreAllMocks();
    delete process.env.AUTH_SERVICE_URL;
    delete process.env.NODE_ENV;
  });

  // ─── AC-1.1: Happy path — 202 { status: 'sent' } ──────────────────────────

  describe('AC-1.1: valid phone + channel → 202 { status: sent }', () => {
    it('AC-1.1: should return 202 { status: sent } when auth-service returns 202', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/start
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleStartOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/start
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/start')
        .reply(202, { status: 'sent' });

      const res = await request(app)
        .post('/api/auth/otp/start')
        .send({ phone_e164: '+447700900123', channel: 'web' });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ status: 'sent' });
    });

    it('AC-1.1: should forward correlation ID to auth-service', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/start
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleStartOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/start
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      let capturedCorrelationId: string | undefined;
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/start')
        .reply(function () {
          capturedCorrelationId = this.req.headers['x-correlation-id'] as string;
          return [202, { status: 'sent' }];
        });

      await request(app)
        .post('/api/auth/otp/start')
        .set('x-correlation-id', 'test-corr-001')
        .send({ phone_e164: '+447700900123', channel: 'web' });

      expect(capturedCorrelationId).toBe('test-corr-001');
    });

    it('AC-1.1: should accept channel=rn and forward to auth-service', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/start
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleStartOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/start
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/start')
        .reply(202, { status: 'sent' });

      const res = await request(app)
        .post('/api/auth/otp/start')
        .send({ phone_e164: '+12025551234', channel: 'rn' });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ status: 'sent' });
    });

    it('AC-1.1: should accept channel=swift and forward to auth-service', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/start
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleStartOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/start
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/start')
        .reply(202, { status: 'sent' });

      const res = await request(app)
        .post('/api/auth/otp/start')
        .send({ phone_e164: '+447700900999', channel: 'swift' });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ status: 'sent' });
    });
  });

  // ─── AC-1.2: invalid phone_e164 → 400 without calling auth-service ─────────

  describe('AC-1.2: invalid phone_e164 → 400 without calling auth-service', () => {
    it('AC-1.2: should return 400 with details=phone_e164 for non-E164 phone (no plus)', async () => {
      const scope = nock(AUTH_SERVICE_URL).post('/auth/otp/start').reply(202, { status: 'sent' });

      const res = await request(app)
        .post('/api/auth/otp/start')
        .send({ phone_e164: 'not-e164', channel: 'web' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid_request', details: 'phone_e164' });
      // Auth-service must NOT have been called
      expect(scope.isDone()).toBe(false);
      nock.cleanAll();
    });

    it('AC-1.2: should return 400 for missing phone_e164', async () => {
      const scope = nock(AUTH_SERVICE_URL).post('/auth/otp/start').reply(202, { status: 'sent' });

      const res = await request(app)
        .post('/api/auth/otp/start')
        .send({ channel: 'web' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid_request', details: 'phone_e164' });
      expect(scope.isDone()).toBe(false);
      nock.cleanAll();
    });

    it('AC-1.2: should return 400 for phone missing country code (no +)', async () => {
      const scope = nock(AUTH_SERVICE_URL).post('/auth/otp/start').reply(202, { status: 'sent' });

      const res = await request(app)
        .post('/api/auth/otp/start')
        .send({ phone_e164: '07700900123', channel: 'web' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid_request', details: 'phone_e164' });
      expect(scope.isDone()).toBe(false);
      nock.cleanAll();
    });

    it('AC-1.2: should return 400 for phone starting with +0 (invalid leading digit)', async () => {
      const scope = nock(AUTH_SERVICE_URL).post('/auth/otp/start').reply(202, { status: 'sent' });

      const res = await request(app)
        .post('/api/auth/otp/start')
        .send({ phone_e164: '+0447700900123', channel: 'web' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid_request', details: 'phone_e164' });
      expect(scope.isDone()).toBe(false);
      nock.cleanAll();
    });
  });

  // ─── AC-1.3: channel='whatsapp' → 400 without calling auth-service ─────────

  describe('AC-1.3: channel=whatsapp → 400 { error: invalid_request, details: channel }', () => {
    it('AC-1.3: should return 400 for channel=whatsapp (not in BFF enum)', async () => {
      const scope = nock(AUTH_SERVICE_URL).post('/auth/otp/start').reply(202, { status: 'sent' });

      const res = await request(app)
        .post('/api/auth/otp/start')
        .send({ phone_e164: '+447700900123', channel: 'whatsapp' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid_request', details: 'channel' });
      expect(scope.isDone()).toBe(false);
      nock.cleanAll();
    });

    it('AC-1.3: should return 400 for missing channel', async () => {
      const scope = nock(AUTH_SERVICE_URL).post('/auth/otp/start').reply(202, { status: 'sent' });

      const res = await request(app)
        .post('/api/auth/otp/start')
        .send({ phone_e164: '+447700900123' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid_request', details: 'channel' });
      expect(scope.isDone()).toBe(false);
      nock.cleanAll();
    });

    it('AC-1.3: should return 400 for unknown channel=telegram', async () => {
      const scope = nock(AUTH_SERVICE_URL).post('/auth/otp/start').reply(202, { status: 'sent' });

      const res = await request(app)
        .post('/api/auth/otp/start')
        .send({ phone_e164: '+447700900123', channel: 'telegram' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid_request', details: 'channel' });
      expect(scope.isDone()).toBe(false);
      nock.cleanAll();
    });
  });

  // ─── AC-1.4: auth-service returns 429 → pass-through ──────────────────────

  describe('AC-1.4: auth-service 429 → pass-through to client', () => {
    it('AC-1.4: should return 429 with same body when auth-service rate-limits', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/start (429)
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleStartOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/start
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/start')
        .reply(429, { error: 'rate_limited', retry_after_seconds: 47 });

      const res = await request(app)
        .post('/api/auth/otp/start')
        .send({ phone_e164: '+447700900123', channel: 'web' });

      expect(res.status).toBe(429);
      expect(res.body).toEqual({ error: 'rate_limited', retry_after_seconds: 47 });
    });
  });

  // ─── AC-1.5: auth-service returns 503 → pass-through ──────────────────────

  describe('AC-1.5: auth-service 503 → pass-through to client', () => {
    it('AC-1.5: should return 503 when auth-service is unavailable', async () => {
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/start (503)
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleStartOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/start
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/start')
        .reply(503, { error: 'upstream_unavailable' });

      const res = await request(app)
        .post('/api/auth/otp/start')
        .send({ phone_e164: '+447700900456', channel: 'web' });

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'upstream_unavailable' });
    });
  });

  // ─── AC-1.6: auth-service hangs >5s → AbortController → 503 ──────────────

  describe('AC-1.6: auth-service timeout (>5s) → 503 { error: upstream_unavailable }', () => {
    it('AC-1.6: should return 503 when auth-service call times out after 5s', async () => {
      // nock: delay longer than 5s AbortController timeout
      // Mocked: POST {AUTH_SERVICE_URL}/auth/otp/start (delayed beyond 5s)
      // Verified real: services/auth-service/src/handlers/otp.handler.ts handleStartOtp
      // Exposed at: services/auth-service/src/routes/otp.ts mounted at /auth/otp/start
      // Last verified: 2026-04-26 (Jessie WEB-BFF-003 US-2)
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/start')
        .delayConnection(6000)
        .reply(202, { status: 'sent' });

      const res = await request(app)
        .post('/api/auth/otp/start')
        .send({ phone_e164: '+447700900789', channel: 'web' })
        .timeout(10000);

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ error: 'upstream_unavailable' });
    }, 15000);

    it('AC-1.6: should not call auth-service more than once on timeout', async () => {
      let callCount = 0;
      nock(AUTH_SERVICE_URL)
        .post('/auth/otp/start')
        .times(3)
        .reply(function () {
          callCount++;
          // Simulate a connection refused / immediate error path
          return [503, { error: 'upstream_unavailable' }];
        });

      await request(app)
        .post('/api/auth/otp/start')
        .send({ phone_e164: '+447700900321', channel: 'rn' });

      // BFF must not retry; exactly one call
      expect(callCount).toBeLessThanOrEqual(1);
    });
  });
});
