/**
 * T2 RED tests: check-delay handler — BFF swallows journey-matcher 4xx
 *
 * Troubleshooting workflow: T2-test (Jessie, 2026-06-07)
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify this file.
 *
 * ─── Defect B secondary: BFF swallows matcher 4xx ────────────────────────────
 *
 * Root cause (Blake T1 finding):
 *   check-delay.handler.ts handles these cases explicitly:
 *     - jmResult.statusCode >= 500  → 503 upstream_unavailable
 *     - jmResult.body.status === 'candidates'  → 200 pass-through
 *     - jmResult.body.status === 'no_match'    → 200 no_match
 *   A journey-matcher 400 (bad_request, e.g. actual_departure_time ISO not HH:MM) falls
 *   through ALL three checks. The handler proceeds to:
 *     const journeyId = jmResult.body.journey_id as string; // undefined
 *     await queryDelay(undefined, ...) → crash / unexpected behavior
 *   The BFF logs "full composite response assembled" and the PWA sees a generic error.
 *
 * Fix (Blake will make):
 *   Add a 4xx guard immediately after the 5xx guard:
 *     if (jmResult.statusCode >= 400 && jmResult.statusCode < 500) {
 *       res.status(400).json({ error: 'validation_error', service: 'journey-matcher' });
 *       return;
 *     }
 *   The guard fires BEFORE status=candidates and status=no_match checks.
 *
 * ─── Why tests are RED now ───────────────────────────────────────────────────
 *   Current handler: no 4xx guard. A 400 from matchJourney falls through to
 *   `const journeyId = jmResult.body.journey_id as string` (undefined), then
 *   `await queryDelay(undefined, ...)` is called. Tests asserting:
 *     - response status === 400 (currently gets 500 or 200 composite)
 *     - mockQueryDelay not called (currently IS called with undefined journeyId)
 *   will FAIL on current code.
 *
 * This file is ADDITIVE to check-delay-jm002.handler.test.ts (AC-7 tests).
 * Pre-existing tests are NOT duplicated here.
 *
 * Mocked modules:
 *   src/lib/journey-matcher-client.js — matchJourney mock
 *   src/lib/delay-tracker-client.js   — queryDelay mock
 *   src/lib/eligibility-engine-client.js — getEligibility mock
 *   src/lib/evaluation-coordinator-client.js — triggerEvaluation mock
 *   @railrepay/winston-logger — shared logger mock
 *   @railrepay/metrics-pusher — counter + histogram mocks
 *
 * ADR references:
 *   ADR-002 — Structured logging
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture
 *   ADR-027 — BFF owns canonical client-facing contract
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  CHECK_DELAY_USER,
} from '../../fixtures/check-delay-data.js';

// ─── Infrastructure Package Mocking (CLAUDE.md §6.1 #11) ─────────────────────
const sharedLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

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

// ─── App factory ─────────────────────────────────────────────────────────────
// @ts-expect-error — module exists; import path is correct
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Valid BFF request body — would result in 400 from journey-matcher */
const VALID_BODY_CAUSES_JM_400 = {
  origin_station: 'York',
  destination_station: 'London Kings Cross',
  departure_date: '2026-06-03',
  departure_time: '08:27',
  ticket_type: 'anytime',
  actual_departure_time: '2026-06-03T08:17:00.000Z', // ISO string — fails JM Zod schema
  actual_rid: '202606031108175',
};

/** Journey-matcher 400 response body — the shape emitted by its Zod validator */
const JM_400_RESPONSE_BODY = {
  error: 'bad_request',
  issues: [
    {
      field: 'actual_departure_time',
      message: 'actual_departure_time must be HH:MM format',
    },
  ],
};

/** Journey-matcher 422 (another 4xx variant — guard must cover all 4xx) */
const JM_422_RESPONSE_BODY = {
  error: 'unprocessable_entity',
  message: 'request semantics invalid',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('T2 Defect B secondary — BFF: journey-matcher 4xx not guarded (handler swallows it)', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
    // Default: delay-tracker and eligibility succeed (but should NOT be called for 4xx)
    mockQueryDelay.mockResolvedValue({
      statusCode: 200,
      body: {
        journey_id: 'jrn-would-not-reach',
        delay_minutes: 0,
        cancelled: false,
        last_observed_at: '2026-06-03T10:00:00Z',
        status: 'on_time',
      },
    });
    mockGetEligibility.mockResolvedValue({
      statusCode: 200,
      body: {
        eligible: false,
        scheme: null,
        compensation_percentage: 0,
        compensation_pence: 0,
        ticket_fare_pence: 0,
        reasons: [],
        applied_rules: [],
        evaluation_timestamp: '2026-06-03T10:00:00Z',
      },
    });
    mockTriggerEvaluation.mockResolvedValue({ statusCode: 202 });
  });

  // ── Primary: 400 from journey-matcher → BFF must return 400, not proceed ──

  describe('Defect B secondary: journey-matcher returns 400 → BFF returns 400 (not composite)', () => {
    it('Defect B: BFF must return 400 when journey-matcher returns statusCode 400', async () => {
      // FAILS NOW: current handler has no 4xx guard. The 400 falls through to:
      //   const journeyId = jmResult.body.journey_id as string; // undefined
      //   await queryDelay(undefined, ...) → unexpected behavior, then tries to assemble composite
      // After fix: guard detects statusCode 400-499 → returns 400 immediately.
      mockMatchJourney.mockResolvedValue({
        statusCode: 400,
        body: JM_400_RESPONSE_BODY,
      });

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('X-Correlation-ID', 'test-jm002-t2-bff-4xx-001')
        .send(VALID_BODY_CAUSES_JM_400)
        .set('Content-Type', 'application/json');

      // FAILS NOW: returns 500 (crash from undefined journeyId) or 200 (composite with undefined)
      // Expected: 400 with validation_error body
      expect(res.status).toBe(400);
    });

    it('Defect B: BFF 400 response body must indicate validation_error from journey-matcher', async () => {
      // After fix: the response body identifies the source service.
      mockMatchJourney.mockResolvedValue({
        statusCode: 400,
        body: JM_400_RESPONSE_BODY,
      });

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('X-Correlation-ID', 'test-jm002-t2-bff-4xx-002')
        .send(VALID_BODY_CAUSES_JM_400)
        .set('Content-Type', 'application/json');

      // FAILS NOW: body is not a clean validation_error response
      expect(res.body.error).toBe('validation_error');
      expect(res.body.service).toBe('journey-matcher');
    });

    it('Defect B: BFF must NOT call delay-tracker when journey-matcher returns 400', async () => {
      // FAILS NOW: current code calls mockQueryDelay with undefined journeyId.
      // After fix: 4xx guard returns early; queryDelay is never called.
      mockMatchJourney.mockResolvedValue({
        statusCode: 400,
        body: JM_400_RESPONSE_BODY,
      });

      await request(app)
        .post('/api/journeys/check-delay')
        .set('X-Correlation-ID', 'test-jm002-t2-bff-4xx-003')
        .send(VALID_BODY_CAUSES_JM_400)
        .set('Content-Type', 'application/json');

      // FAILS NOW: mockQueryDelay IS called with undefined
      expect(mockQueryDelay).not.toHaveBeenCalled();
    });

    it('Defect B: BFF must NOT call eligibility-engine when journey-matcher returns 400', async () => {
      // FAILS NOW: execution reaches eligibility call after undefined journeyId propagates.
      mockMatchJourney.mockResolvedValue({
        statusCode: 400,
        body: JM_400_RESPONSE_BODY,
      });

      await request(app)
        .post('/api/journeys/check-delay')
        .set('X-Correlation-ID', 'test-jm002-t2-bff-4xx-004')
        .send(VALID_BODY_CAUSES_JM_400)
        .set('Content-Type', 'application/json');

      // FAILS NOW: mockGetEligibility may be called
      expect(mockGetEligibility).not.toHaveBeenCalled();
    });
  });

  // ── 4xx guard covers all 4xx status codes, not just 400 ──────────────────

  describe('Defect B secondary: 4xx guard covers all 4xx codes (400, 422)', () => {
    it('Defect B: BFF must return 400 when journey-matcher returns statusCode 422', async () => {
      // The guard must cover any 4xx, not just 400.
      // A 422 from the matcher (e.g. semantic validation failure) must also be caught.
      mockMatchJourney.mockResolvedValue({
        statusCode: 422,
        body: JM_422_RESPONSE_BODY,
      });

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('X-Correlation-ID', 'test-jm002-t2-bff-4xx-005')
        .send(VALID_BODY_CAUSES_JM_400)
        .set('Content-Type', 'application/json');

      // FAILS NOW: 422 also falls through (not guarded)
      expect(res.status).toBe(400);
      expect(mockQueryDelay).not.toHaveBeenCalled();
    });
  });

  // ── Regression guard: existing 5xx → 503 path unchanged ──────────────────

  describe('Regression guard: 5xx handling unchanged by the 4xx fix', () => {
    it('Defect B regression: journey-matcher 500 must still return 503 (unaffected by 4xx fix)', async () => {
      // Verify the 4xx guard does not accidentally swallow 5xx errors.
      // 5xx → 503 was already working; the 4xx fix must not break it.
      mockMatchJourney.mockResolvedValue({
        statusCode: 500,
        body: { error: 'internal_server_error' },
      });

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('X-Correlation-ID', 'test-jm002-t2-bff-4xx-006')
        .send({
          origin_station: 'York',
          destination_station: 'London Kings Cross',
          departure_date: '2026-06-03',
          departure_time: '08:27',
        })
        .set('Content-Type', 'application/json');

      // This already passes; must remain passing after fix
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('upstream_unavailable');
      expect(res.body.service).toBe('journey-matcher');
    });
  });

  // ── Clean validation path: 200 matcher → normal composite (not 400 guard) ─

  describe('Regression guard: valid matcher response still produces composite', () => {
    it('Defect B regression: normal 200 matched response from journey-matcher must NOT trigger 4xx guard', async () => {
      // The guard must only fire for 4xx, not 200.
      // This test ensures the fix is narrowly scoped to 4xx status codes.
      mockMatchJourney.mockResolvedValue({
        statusCode: 200,
        body: {
          status: 'matched',
          journey_id: 'jrn-normal-202606-001',
          origin_crs: 'YRK',
          destination_crs: 'KGX',
          segments: [],
          idempotent_replay: false,
        },
      });
      mockQueryDelay.mockResolvedValue({
        statusCode: 200,
        body: {
          journey_id: 'jrn-normal-202606-001',
          delay_minutes: 45,
          cancelled: false,
          last_observed_at: '2026-06-03T10:00:00Z',
          status: 'delayed',
        },
      });
      mockGetEligibility.mockResolvedValue({
        statusCode: 200,
        body: {
          eligible: true,
          scheme: 'delay_repay',
          compensation_percentage: 50,
          compensation_pence: 4500,
          ticket_fare_pence: 9000,
          reasons: [],
          applied_rules: ['DR_30MIN'],
          evaluation_timestamp: '2026-06-03T10:05:00Z',
        },
      });

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('X-Correlation-ID', 'test-jm002-t2-bff-4xx-007')
        .send({
          origin_station: 'York',
          destination_station: 'London Kings Cross',
          departure_date: '2026-06-03',
          departure_time: '08:27',
          ticket_type: 'anytime',
          actual_departure_time: '09:27', // valid HH:MM
          actual_rid: '202606030927001',
        })
        .set('Content-Type', 'application/json');

      // Normal flow must still work: 200 composite
      expect(res.status).toBe(200);
      expect(res.body.matched).toBe(true);
      // Both downstream calls must have been made
      expect(mockQueryDelay).toHaveBeenCalledTimes(1);
      expect(mockGetEligibility).toHaveBeenCalledTimes(1);
    });
  });
});
