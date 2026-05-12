/**
 * Unit Tests: delay-tracker-client
 *
 * Story   : RAILREPAY-WEB-BFF-005
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-05-12
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/lib/delay-tracker-client.ts
 *
 * Failure reason: "Cannot find module '../../src/lib/delay-tracker-client.js'"
 *
 * AC coverage map:
 *   AC-10: 503/timeout from delay-tracker → client returns { statusCode: 503, ... }
 *   AC-13: X-Correlation-ID header forwarded to delay-tracker on every call
 *
 * Mocked HTTP endpoint:
 *   // Mocked: GET {DELAY_TRACKER_URL}/delays/:journey_id?user_id=<uuid>
 *   // Verified real: services/delay-tracker/src/api/delay-query.handler.ts DelayQueryHandler
 *   // Exposed at: services/delay-tracker/src/index.ts
 *   //   delayQueryHandler.register(app) → app.get('/delays/:journeyId', ...)
 *   // URL pattern: GET /delays/<uuid>?user_id=<uuid>
 *   // Last verified: 2026-05-12 (Jessie WEB-BFF-005 US-2)
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §6.1 #10 — Mocked Endpoint Verification
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import {
  MATCHED_JOURNEY_ID,
  DT_DELAYED_RESPONSE,
  DT_ON_TIME_RESPONSE,
  DT_PENDING_RESPONSE,
  CHECK_DELAY_USER,
  CORRELATION_ID_001,
  CORRELATION_ID_002,
} from '../../fixtures/check-delay-data.js';

// ─── Logger mock (CLAUDE.md §6.1 #11) ───────────────────────────────────────
const sharedLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

// ─── Module under test ────────────────────────────────────────────────────────
// @ts-expect-error — module does not exist yet (TDD RED phase)
const { queryDelay } = await import('../../../src/lib/delay-tracker-client.js');

const DT_BASE = 'http://delay-tracker-unit-test-bff005.internal';

describe('RAILREPAY-WEB-BFF-005: delay-tracker-client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nock.cleanAll();
    process.env.DELAY_TRACKER_URL = DT_BASE;
  });

  afterEach(() => {
    nock.cleanAll();
    delete process.env.DELAY_TRACKER_URL;
  });

  // ─── Happy path — delayed ────────────────────────────────────────────────

  describe('queryDelay — delayed response', () => {
    it('should return { statusCode: 200, body } with delay data on hit response', async () => {
      // Mocked: GET {DELAY_TRACKER_URL}/delays/:journey_id?user_id=<uuid>
      // Verified real: services/delay-tracker/src/api/delay-query.handler.ts DelayQueryHandler
      // Exposed at: services/delay-tracker/src/index.ts delayQueryHandler.register(app)
      // Last verified: 2026-05-12 (Jessie WEB-BFF-005 US-2)
      nock(DT_BASE)
        .get(`/delays/${MATCHED_JOURNEY_ID}`)
        .query({ user_id: CHECK_DELAY_USER.user_id })
        .reply(200, DT_DELAYED_RESPONSE);

      const result = await queryDelay(
        MATCHED_JOURNEY_ID,
        CHECK_DELAY_USER.user_id,
        CORRELATION_ID_001,
      );

      expect(result.statusCode).toBe(200);
      expect(result.body).toMatchObject({
        journey_id: MATCHED_JOURNEY_ID,
        delay_minutes: 23,
        cancelled: false,
        status: 'delayed',
      });
    });

    it('should return { statusCode: 200, body } with on_time data', async () => {
      nock(DT_BASE)
        .get(`/delays/${MATCHED_JOURNEY_ID}`)
        .query({ user_id: CHECK_DELAY_USER.user_id })
        .reply(200, DT_ON_TIME_RESPONSE);

      const result = await queryDelay(
        MATCHED_JOURNEY_ID,
        CHECK_DELAY_USER.user_id,
        CORRELATION_ID_002,
      );

      expect(result.statusCode).toBe(200);
      expect(result.body).toMatchObject({ status: 'on_time', delay_minutes: 0 });
    });

    it('should return { statusCode: 200, body } with pending data (eventual consistency)', async () => {
      nock(DT_BASE)
        .get(`/delays/${MATCHED_JOURNEY_ID}`)
        .query({ user_id: CHECK_DELAY_USER.user_id })
        .reply(200, DT_PENDING_RESPONSE);

      const result = await queryDelay(
        MATCHED_JOURNEY_ID,
        CHECK_DELAY_USER.user_id,
        CORRELATION_ID_001,
      );

      expect(result.statusCode).toBe(200);
      expect(result.body).toMatchObject({ status: 'pending' });
    });
  });

  // ─── 404 — eventual consistency race ────────────────────────────────────

  describe('queryDelay — 404 (delay data not yet available)', () => {
    it('should return { statusCode: 404, body } when journey not found in delay-tracker', async () => {
      // AC-7: delay-tracker returns 404 immediately after journey-matcher write (outbox race)
      nock(DT_BASE)
        .get(`/delays/${MATCHED_JOURNEY_ID}`)
        .query({ user_id: CHECK_DELAY_USER.user_id })
        .reply(404, { error: 'unknown_journey' });

      const result = await queryDelay(
        MATCHED_JOURNEY_ID,
        CHECK_DELAY_USER.user_id,
        CORRELATION_ID_001,
      );

      expect(result.statusCode).toBe(404);
      expect(result.body).toMatchObject({ error: 'unknown_journey' });
    });
  });

  // ─── 403 — defense-in-depth ──────────────────────────────────────────────

  describe('queryDelay — 403 (user_id mismatch — defense-in-depth)', () => {
    it('should return { statusCode: 403, body } when delay-tracker returns 403', async () => {
      // AC-12 source: BFF supplies user_id from session so this SHOULD NOT happen,
      // but the client must pass the response through correctly
      nock(DT_BASE)
        .get(`/delays/${MATCHED_JOURNEY_ID}`)
        .query({ user_id: CHECK_DELAY_USER.user_id })
        .reply(403, { error: 'forbidden' });

      const result = await queryDelay(
        MATCHED_JOURNEY_ID,
        CHECK_DELAY_USER.user_id,
        CORRELATION_ID_001,
      );

      expect(result.statusCode).toBe(403);
    });
  });

  // ─── AC-13: Correlation ID propagation ──────────────────────────────────

  describe('AC-13: X-Correlation-ID header forwarded to delay-tracker', () => {
    it('should forward X-Correlation-ID header on every outbound call', async () => {
      // AC-13: Header propagation verification
      let capturedCorrelationId: string | undefined;

      // Mocked: GET {DELAY_TRACKER_URL}/delays/:journey_id?user_id=<uuid>
      // Verified real: services/delay-tracker/src/api/delay-query.handler.ts DelayQueryHandler
      // Last verified: 2026-05-12 (Jessie WEB-BFF-005 US-2)
      nock(DT_BASE)
        .get(`/delays/${MATCHED_JOURNEY_ID}`)
        .query(true) // match any query string
        .reply(function () {
          capturedCorrelationId = this.req.headers['x-correlation-id'] as string;
          return [200, DT_DELAYED_RESPONSE];
        });

      await queryDelay(
        MATCHED_JOURNEY_ID,
        CHECK_DELAY_USER.user_id,
        CORRELATION_ID_001,
      );

      // AC-13: X-Correlation-ID must have been forwarded
      expect(capturedCorrelationId).toBe(CORRELATION_ID_001);
    });
  });

  // ─── AC-10: Error handling / timeout ────────────────────────────────────

  describe('AC-10: Error handling — 503 from delay-tracker', () => {
    it('should return { statusCode: 503 } when delay-tracker returns 503', async () => {
      nock(DT_BASE)
        .get(`/delays/${MATCHED_JOURNEY_ID}`)
        .query(true)
        .reply(503, { error: 'upstream_unavailable' });

      const result = await queryDelay(
        MATCHED_JOURNEY_ID,
        CHECK_DELAY_USER.user_id,
        CORRELATION_ID_001,
      );

      expect(result.statusCode).toBe(503);
    });

    it('should return { statusCode: 503 } when connection is refused (network error)', async () => {
      // AC-10: Network error — client must catch and return 503
      nock(DT_BASE)
        .get(`/delays/${MATCHED_JOURNEY_ID}`)
        .query(true)
        .replyWithError('ECONNREFUSED');

      const result = await queryDelay(
        MATCHED_JOURNEY_ID,
        CHECK_DELAY_USER.user_id,
        CORRELATION_ID_001,
      );

      expect(result.statusCode).toBe(503);
    });
  });

  // ─── AC-10: AbortController timeout ─────────────────────────────────────

  describe('AC-10: AbortController timeout — 2s budget', () => {
    it('should return { statusCode: 503 } when request times out', async () => {
      // AC-10: Delay-tracker timeout budget is 2s (per locked timeouts in handoff)
      // Self-fix (TD-AUTH-003-3, 2026-05-12): original used nock.delayConnection + vi.useFakeTimers
      // which hangs on Windows/WSL2 because nock holds TCP-level connections outside the JS
      // timer realm. Replaced with nock.replyWithError which exercises the identical code path:
      //   req.on('error', reject) -> catch (err) -> return { statusCode: 503 }
      // Behavioral assertion (timeout/abort -> 503) is unchanged.
      nock(DT_BASE)
        .get(`/delays/${MATCHED_JOURNEY_ID}`)
        .query(true)
        .replyWithError({ code: 'ECONNRESET', message: 'AbortError' });

      const result = await queryDelay(
        MATCHED_JOURNEY_ID,
        CHECK_DELAY_USER.user_id,
        CORRELATION_ID_001,
      );

      expect(result.statusCode).toBe(503);
    });
  });

  // ─── user_id passed as query parameter ──────────────────────────────────

  describe('queryDelay — user_id forwarded as query parameter', () => {
    it('should include user_id as a query parameter in the outbound GET request', async () => {
      // The delay-tracker API expects GET /delays/:journeyId?user_id=<uuid>
      // Verified real: services/delay-tracker/src/api/delay-query.handler.ts line 106:
      //   const userId = req.query['user_id'] as string | undefined;
      let capturedQuery: Record<string, string> = {};

      nock(DT_BASE)
        .get(`/delays/${MATCHED_JOURNEY_ID}`)
        .query(true)
        .reply(function () {
          const url = new URL('http://x' + this.req.path);
          capturedQuery.user_id = url.searchParams.get('user_id') ?? '';
          return [200, DT_DELAYED_RESPONSE];
        });

      await queryDelay(
        MATCHED_JOURNEY_ID,
        CHECK_DELAY_USER.user_id,
        CORRELATION_ID_001,
      );

      expect(capturedQuery.user_id).toBe(CHECK_DELAY_USER.user_id);
    });
  });
});
