/**
 * BL-313: web-app-bff check-delay handler must source toc_code from delayBody
 * (the delay-tracker response) — NOT from req.body.toc_code.
 *
 * Bug Fix  : BL-313 (ADR-030, Option B) — The handler currently reads:
 *              toc_code: typeof rawBody.toc_code === 'string' ? rawBody.toc_code : undefined
 *            req.body never contains toc_code (the PWA does not send it), so
 *            toc_code is always undefined in the triggerEvaluation payload.
 *            Fix: source toc_code from delayBody.toc_code (the delay-tracker
 *            GET /delays/:journeyId response body, which now carries toc_code
 *            per ADR-030 Option B).
 *
 * Phase    : T2-test (Jessie — Test Specification, TDD per ADR-014)
 * Date     : 2026-05-28
 * ADR-030  : Option B — BFF sources toc_code from delay response, not req.body
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * THESE TESTS MUST FAIL ON CURRENT CODE (web-app-bff HEAD).
 * Current handler code (check-delay.handler.ts ~line 387):
 *   toc_code: typeof rawBody.toc_code === 'string' ? rawBody.toc_code : undefined
 * req.body does NOT contain toc_code from the PWA, so toc_code is always
 * undefined in the trigger payload. The new assertion will fail because it
 * expects toc_code to come from delayBody (delay-tracker response).
 *
 * BL-311 interaction note: The BL-311 tests in check-delay-bl311-trigger-payload.test.ts
 * assert that triggerEvaluation is called with delay_minutes and ticket_fare_pence.
 * THIS file EXTENDS those tests by additionally asserting the toc_code SOURCE.
 * These tests do NOT conflict with or duplicate BL-311 tests — they extend them.
 * Specifically: BL-311 asserts delay_minutes comes from delayBody; BL-313 asserts
 * toc_code comes from delayBody (not req.body).
 *
 * AC coverage map (BL-313 BFF slice):
 *   AC-3 (DISPOSITIVE): triggerEvaluation payload includes toc_code sourced from
 *         delayBody.toc_code (NOT from req.body), which is the delay-tracker response.
 *   AC-3: When delayBody.toc_code is null, triggerEvaluation receives toc_code: null
 *         (NOT 'UNKNOWN', NOT undefined — the engine handles null gracefully).
 *   AC-3: toc_code is NOT sourced from req.body (regression guard against re-adding
 *         the original broken source).
 *
 * Infrastructure Package Mocking (CLAUDE.md §6.1 #11):
 *   Shared logger instance OUTSIDE vi.mock factory.
 *
 * Mocked dependencies (same pattern as check-delay-bl311-trigger-payload.test.ts):
 *   ../../../src/lib/journey-matcher-client.js
 *   ../../../src/lib/delay-tracker-client.js
 *   ../../../src/lib/eligibility-engine-client.js
 *   ../../../src/lib/evaluation-coordinator-client.js
 *   @railrepay/winston-logger
 *   @railrepay/metrics-pusher
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  VALID_CHECK_DELAY_BODY,
  MATCHED_JOURNEY_ID,
  JM_MATCH_RESPONSE_DELAYED,
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
// @ts-expect-error — module exists, signature changes in BL-313
const { createCheckDelayHandler } = await import('../../../src/handlers/check-delay.handler.js');

// ─── Extended delay-tracker responses carrying toc_code (BL-313) ──────────────

/**
 * Delay-tracker response for XC service — includes toc_code after BL-313 fix.
 * Source: delay-tracker GET /delays/:journeyId hit response
 * Verified contract: services/delay-tracker/src/api/delay-query.handler.ts
 *   GetDelayHitResponse will include toc_code after BL-313 fix.
 */
const DT_DELAYED_WITH_XC_TOC = {
  journey_id: MATCHED_JOURNEY_ID,
  delay_minutes: 118,
  cancelled: false,
  last_observed_at: '2025-03-11T12:00:00.000Z',
  status: 'delayed' as const,
  toc_code: 'XC',   // BL-313: new field in delay-tracker response
};

/** Delay response with null toc_code (common prod case) */
const DT_DELAYED_WITH_NULL_TOC = {
  journey_id: MATCHED_JOURNEY_ID,
  delay_minutes: 45,
  cancelled: false,
  last_observed_at: '2025-03-11T13:00:00.000Z',
  status: 'delayed' as const,
  toc_code: null,   // BL-313: null, not 'UNKNOWN'
};

// ─── App builder ──────────────────────────────────────────────────────────────

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

/** Common upstream mock setup: JM matched, DT returns supplied response, EE 404 */
function setupMocksForPendingEligibilityWithDt(
  dtResponse: typeof DT_DELAYED_WITH_XC_TOC | typeof DT_DELAYED_WITH_NULL_TOC
) {
  mockMatchJourney.mockResolvedValue({
    statusCode: 200,
    body: JM_MATCH_RESPONSE_DELAYED,
  });
  mockQueryDelay.mockResolvedValue({
    statusCode: 200,
    body: dtResponse,
  });
  // 404 → triggers evaluation (path that calls triggerEvaluation)
  mockGetEligibility.mockResolvedValue({
    statusCode: 404,
    body: { error: 'Evaluation not found', journey_id: MATCHED_JOURNEY_ID },
  });
  mockTriggerEvaluation.mockResolvedValue(undefined);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('BL-313: check-delay handler — toc_code sourced from delayBody (AC-3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-3 (DISPOSITIVE): toc_code comes from delayBody.toc_code, not req.body
  //
  // WILL FAIL on current code: the handler reads
  //   toc_code: typeof rawBody.toc_code === 'string' ? rawBody.toc_code : undefined
  // The request body has no toc_code field, so toc_code = undefined in the payload.
  // The test expects toc_code = 'XC' (from DT response) → fails.
  // ──────────────────────────────────────────────────────────────────────────

  describe('AC-3 (DISPOSITIVE): triggerEvaluation receives toc_code from delayBody, not req.body', () => {
    it('AC-3: triggerEvaluation payload includes toc_code = XC from delay-tracker response', async () => {
      // AC-3: When delay-tracker returns toc_code: 'XC' in the hit response,
      // the handler must forward that value to triggerEvaluation as toc_code.
      // The req.body has NO toc_code field — confirming the source is delayBody.
      //
      // WILL FAIL on current code: handler reads rawBody.toc_code (undefined)
      // instead of delayBody.toc_code ('XC'). The third arg to triggerEvaluation
      // will have toc_code: undefined, not 'XC'.

      setupMocksForPendingEligibilityWithDt(DT_DELAYED_WITH_XC_TOC);

      const app = buildApp();
      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);  // No toc_code in body — source must be delayBody

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending_eligibility');

      // AC-3 DISPOSITIVE: toc_code must come from delay response (DT_DELAYED_WITH_XC_TOC.toc_code)
      expect(mockTriggerEvaluation).toHaveBeenCalledWith(
        MATCHED_JOURNEY_ID,
        CORRELATION_ID_001,
        expect.objectContaining({ toc_code: 'XC' })  // from delayBody, not req.body
      );
    });

    it('AC-3: triggerEvaluation receives toc_code = null when delay-tracker returns null', async () => {
      // AC-3: When toc_code is null in the delay response (common prod case),
      // the trigger payload must carry toc_code: null — NOT 'UNKNOWN'.
      // The coordinator will abort gracefully rather than call evaluate() with UNKNOWN.
      //
      // WILL FAIL on current code: handler reads rawBody.toc_code (undefined) so
      // toc_code in the payload is undefined, not null.

      setupMocksForPendingEligibilityWithDt(DT_DELAYED_WITH_NULL_TOC);

      const app = buildApp();
      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending_eligibility');

      // AC-3: null must be forwarded, not converted to undefined or 'UNKNOWN'
      expect(mockTriggerEvaluation).toHaveBeenCalledWith(
        MATCHED_JOURNEY_ID,
        CORRELATION_ID_001,
        expect.objectContaining({ toc_code: null })
      );
    });

    it('AC-3: toc_code NOT sourced from req.body — regression guard', async () => {
      // AC-3: Regression guard. If someone adds toc_code to req.body and the handler
      // accidentally reads req.body again, this test catches it.
      // We set req.body.toc_code = 'GW' (wrong) but delayBody.toc_code = 'XC' (correct).
      // The handler MUST use 'XC' (delayBody), NOT 'GW' (req.body).
      //
      // WILL FAIL on current code: handler reads rawBody.toc_code = 'GW' → payload
      // has toc_code: 'GW'. The assertion for 'XC' fails.

      setupMocksForPendingEligibilityWithDt(DT_DELAYED_WITH_XC_TOC);

      const app = buildApp();
      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        // req.body contains a WRONG toc_code (the PWA doesn't send this, but regression test)
        .send({ ...VALID_CHECK_DELAY_BODY, toc_code: 'GW' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending_eligibility');

      // Must use 'XC' from delayBody, NOT 'GW' from req.body
      expect(mockTriggerEvaluation).toHaveBeenCalledWith(
        MATCHED_JOURNEY_ID,
        CORRELATION_ID_001,
        expect.objectContaining({ toc_code: 'XC' })  // delayBody wins
      );
    });

    it('AC-3: combined payload — delay_minutes from delayBody AND toc_code from delayBody', async () => {
      // AC-3: Full combined assertion: both delay_minutes (BL-311) and toc_code (BL-313)
      // must come from the same source — delayBody (delay-tracker response).
      //
      // WILL FAIL on current code: delay_minutes passes (BL-311 already GREEN) but
      // toc_code is undefined instead of 'XC'.

      setupMocksForPendingEligibilityWithDt(DT_DELAYED_WITH_XC_TOC);

      const app = buildApp();
      await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      // Both delay_minutes AND toc_code must be present in the trigger payload
      expect(mockTriggerEvaluation).toHaveBeenCalledWith(
        MATCHED_JOURNEY_ID,
        CORRELATION_ID_001,
        expect.objectContaining({
          delay_minutes: 118,   // from DT_DELAYED_WITH_XC_TOC.delay_minutes
          toc_code: 'XC',      // from DT_DELAYED_WITH_XC_TOC.toc_code
        })
      );
    });
  });
});
