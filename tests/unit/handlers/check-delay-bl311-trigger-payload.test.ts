/**
 * BL-311: check-delay handler must pass delay_minutes + ticket_fare_pence into triggerEvaluation
 *
 * Bug Fix  : BL-311 — The handler calls triggerEvaluation(journeyId, correlationId) with no
 *            payload. The coordinator receives no delay_minutes/toc_code/ticket_fare_pence,
 *            so evaluate() defaults to UNKNOWN/0 even after the coordinator-side fix.
 *            Fix: handler must extract delay_minutes from delayBody + ticket_fare_pence from
 *            the request (scan context / session), and pass them into triggerEvaluation().
 * Phase    : T2-test (Jessie — Test Specification, TDD per ADR-014)
 * Date     : 2026-05-28
 * ADR-029  : Option A fix (human-approved)
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * THESE TESTS MUST FAIL ON CURRENT CODE (BFF HEAD 01a373e).
 * The handler invokes triggerEvaluation(journeyId, correlationId) — two args.
 * After the fix it must pass a third trigger-payload arg with delay_minutes +
 * ticket_fare_pence. Assertions on the mock call's third argument will fail.
 *
 * AC coverage map (BL-311 handler slice):
 *   AC-5b (DISPOSITIVE): triggerEvaluation() is called with delay_minutes sourced
 *         from delayBody.delay_minutes (the real observed delay from delay-tracker)
 *   AC-5b: triggerEvaluation() is called with ticket_fare_pence (from scan context / request)
 *
 * Infrastructure Package Mocking (CLAUDE.md §6.1 #11):
 *   Shared logger instance OUTSIDE vi.mock factory.
 *
 * Mocked dependencies:
 *   ../../../src/lib/journey-matcher-client.js
 *   ../../../src/lib/delay-tracker-client.js
 *   ../../../src/lib/eligibility-engine-client.js
 *   ../../../src/lib/evaluation-coordinator-client.js
 *   @railrepay/winston-logger
 *   @railrepay/metrics-pusher
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-014 — TDD
 *   ADR-029 — Coordinator must call evaluate() not checkEligibility() (Option A fix)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  VALID_CHECK_DELAY_BODY,
  MATCHED_JOURNEY_ID,
  JM_MATCH_RESPONSE_DELAYED,
  DT_DELAYED_RESPONSE,
  CHECK_DELAY_USER,
  CORRELATION_ID_001,
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

// ─── Metrics mock ─────────────────────────────────────────────────────────────
const mockCounter = { inc: vi.fn() };
const mockHistogram = { observe: vi.fn() };
const mockRegistry = { getSingleMetric: vi.fn(() => undefined) };

vi.mock('@railrepay/metrics-pusher', () => {
  const MockCounter = vi.fn(() => mockCounter);
  const MockHistogram = vi.fn(() => mockHistogram);
  return {
    getRegistry: vi.fn(() => mockRegistry),
    Counter: MockCounter,
    Histogram: MockHistogram,
  };
});

// ─── Client mocks ─────────────────────────────────────────────────────────────

const mockMatchJourney = vi.fn();
vi.mock('../../../src/lib/journey-matcher-client.js', () => ({
  matchJourney: (...args: unknown[]) => mockMatchJourney(...args),
}));

const mockQueryDelay = vi.fn();
vi.mock('../../../src/lib/delay-tracker-client.js', () => ({
  queryDelay: (...args: unknown[]) => mockQueryDelay(...args),
}));

const mockGetEligibility = vi.fn();
vi.mock('../../../src/lib/eligibility-engine-client.js', () => ({
  getEligibility: (...args: unknown[]) => mockGetEligibility(...args),
}));

const mockTriggerEvaluation = vi.fn();
vi.mock('../../../src/lib/evaluation-coordinator-client.js', () => ({
  triggerEvaluation: (...args: unknown[]) => mockTriggerEvaluation(...args),
}));

// ─── Handler under test ───────────────────────────────────────────────────────
// @ts-expect-error — module exists (created in BL-308) but signature changes in BL-311
const { createCheckDelayHandler } = await import('../../../src/handlers/check-delay.handler.js');

function buildApp(sessionUserId: string | null = CHECK_DELAY_USER.user_id) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  app.use((req: any, _res: any, next: any) => {
    if (sessionUserId !== null) {
      req.session = {
        user_id: sessionUserId,
        session_id: CHECK_DELAY_USER.session_id,
        source: 'cookie' as const,
      };
    }
    next();
  });

  app.post('/api/journeys/check-delay', createCheckDelayHandler());
  return app;
}

// ─── Shared upstream mock setup for the pending_eligibility path ──────────────

/** Sets up the three upstream mocks to reach the triggerEvaluation call:
 *   journey-matcher → 200 matched
 *   delay-tracker   → 200 delayed (delay_minutes = 23)
 *   eligibility-engine → 404 (race — no row yet → triggers evaluation)
 */
function setupMocksForPendingEligibility() {
  mockMatchJourney.mockResolvedValue({
    statusCode: 200,
    body: JM_MATCH_RESPONSE_DELAYED,
  });

  mockQueryDelay.mockResolvedValue({
    statusCode: 200,
    body: DT_DELAYED_RESPONSE, // delay_minutes: 23, cancelled: false
  });

  // 404 → triggers evaluation (the path that calls triggerEvaluation)
  mockGetEligibility.mockResolvedValue({
    statusCode: 404,
    body: { error: 'Evaluation not found', journey_id: MATCHED_JOURNEY_ID },
  });

  mockTriggerEvaluation.mockResolvedValue(undefined);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('BL-311: check-delay handler — triggerEvaluation trigger payload (AC-5b)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-5b (DISPOSITIVE): handler passes delay_minutes from delayBody
  // into the triggerEvaluation call
  // WILL FAIL on current code: triggerEvaluation called with only 2 args;
  // the third arg (trigger payload) is absent.
  // ──────────────────────────────────────────────────────────────────────────

  describe('AC-5b (DISPOSITIVE): triggerEvaluation called with real delay_minutes from delayBody', () => {
    it('AC-5b: triggerEvaluation receives delay_minutes = 23 (from DT_DELAYED_RESPONSE)', async () => {
      // AC-5b: When eligibility-engine returns 404, the handler must fire:
      //   triggerEvaluation(journeyId, correlationId, { delay_minutes: 23, ... })
      // where 23 is the actual delay from delay-tracker (not 0, not undefined).
      //
      // WILL FAIL on current code: triggerEvaluation is called as
      //   triggerEvaluation(journeyId, correlationId)
      // — no third argument. toHaveBeenCalledWith(anything, anything, objectContaining(…)) fails.

      setupMocksForPendingEligibility();

      const app = buildApp();
      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      // Handler must still return 200 pending_eligibility
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending_eligibility');

      // AC-5b: triggerEvaluation must have been called with the REAL delay from delay-tracker
      expect(mockTriggerEvaluation).toHaveBeenCalledWith(
        MATCHED_JOURNEY_ID,
        CORRELATION_ID_001,
        expect.objectContaining({ delay_minutes: DT_DELAYED_RESPONSE.delay_minutes }) // 23
      );
    });

    it('AC-5b: triggerEvaluation is NOT called for non-404 eligibility responses (regression guard)', async () => {
      // AC-5b: triggerEvaluation must ONLY fire on the 404 path (race condition).
      // For a successful eligibility response (200), it must NOT fire.

      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: JM_MATCH_RESPONSE_DELAYED });
      mockQueryDelay.mockResolvedValue({ statusCode: 200, body: DT_DELAYED_RESPONSE });
      mockGetEligibility.mockResolvedValue({
        statusCode: 200,
        body: {
          journey_id: MATCHED_JOURNEY_ID,
          eligible: true,
          scheme: 'DR15',
          delay_minutes: 23,
          compensation_percentage: 25,
          compensation_pence: 2238,
          ticket_fare_pence: 8950,
          reasons: [],
          applied_rules: [],
          evaluation_timestamp: '2026-05-28T12:00:00.000Z',
        }
      });

      const app = buildApp();
      await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      // AC-5b: trigger must NOT have fired for a 200 eligibility response
      expect(mockTriggerEvaluation).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-5b: ticket_fare_pence forwarded into triggerEvaluation
  // The BFF request body or session context must supply this value.
  // ──────────────────────────────────────────────────────────────────────────

  describe('AC-5b: triggerEvaluation receives ticket_fare_pence from request context', () => {
    it('AC-5b: triggerEvaluation trigger payload includes ticket_fare_pence when provided in request', async () => {
      // AC-5b: The BFF request can carry ticket_fare_pence (e.g. from the scan/ticket context).
      // When present, the handler must forward it into the trigger payload.
      //
      // WILL FAIL on current code: no third argument passed to triggerEvaluation.

      setupMocksForPendingEligibility();

      const app = buildApp();
      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send({ ...VALID_CHECK_DELAY_BODY, ticket_fare_pence: 8950 });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending_eligibility');

      // AC-5b: ticket_fare_pence must be present in the trigger payload
      expect(mockTriggerEvaluation).toHaveBeenCalledWith(
        MATCHED_JOURNEY_ID,
        CORRELATION_ID_001,
        expect.objectContaining({ ticket_fare_pence: 8950 })
      );
    });

    it('AC-5b: triggerEvaluation trigger payload includes journey_id (not null or scan_id)', async () => {
      // AC-5b: the journey_id passed to triggerEvaluation must be the UUID returned
      // by journey-matcher (not the scan_id, not null). This is a regression from BL-308.

      setupMocksForPendingEligibility();

      const app = buildApp();
      await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      // First arg must be the real journey_id from journey-matcher
      expect(mockTriggerEvaluation).toHaveBeenCalledWith(
        MATCHED_JOURNEY_ID,  // the UUID from JM_MATCH_RESPONSE_DELAYED.journey_id
        expect.any(String),
        expect.anything()
      );
    });
  });
});
