/**
 * Unit Tests: check-delay handler — POST /api/journeys/check-delay
 *
 * Story   : RAILREPAY-WEB-BFF-005
 * Bug Fix : BL-308 — on-demand check-delay never triggers eligibility evaluation
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 *           T2-test (Jessie — BL-308 dispositive-RED + AC-1..5 non-fatal triggers)
 * Date    : 2026-05-12 (original), 2026-05-28 (BL-308 additions)
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/handlers/check-delay.handler.ts
 *   src/lib/journey-matcher-client.ts
 *   src/lib/delay-tracker-client.ts
 *   src/lib/eligibility-engine-client.ts
 *   src/lib/evaluation-coordinator-client.ts  ← NEW (BL-308)
 *   src/routes/journeys.ts (mounts POST /api/journeys/check-delay)
 *
 * Failure reason: "Cannot find module" for all three client mocks.
 *
 * AC coverage map (WEB-BFF-005 existing):
 *   AC-1:  Body validation — each required field missing → 400 with Zod field-level details
 *   AC-2:  No session → 401 { error: 'unauthorized' }
 *   AC-3:  Happy path matched + delayed → 200 flat composite with journey + delay + eligibility
 *   AC-4:  Happy path matched + on_time → 200 with delay_minutes=0, status='on_time', eligibility
 *   AC-5:  Happy path matched + cancelled → 200 with status='cancelled', cancelled=true, eligibility
 *   AC-6:  No-match path → 200 { matched: false, journey_id: null, reason, detail? }
 *          Does NOT call delay-tracker or eligibility-engine
 *   AC-7:  Matched + delay-tracker 404 (race) → 200 { status: 'pending' }
 *          Does NOT call eligibility-engine
 *   AC-8:  Matched + delay-tracker OK + eligibility-engine 404 (race) →
 *          200 with delay data present, status: 'pending_eligibility' (or similar)
 *   AC-9:  journey-matcher 503/timeout → 503 { error: 'upstream_unavailable', service: 'journey-matcher' }
 *   AC-10: delay-tracker 503/timeout → 503 { error: 'upstream_unavailable', service: 'delay-tracker' }
 *   AC-11: eligibility-engine 503/timeout → 503 { error: 'upstream_unavailable', service: 'eligibility-engine' }
 *   AC-12: delay-tracker 403 (defense-in-depth) → 500
 *   AC-14: Logging — structured log per request with outcome and upstream labels
 *   AC-15: Metrics — counter + histogram updated per outcome
 *
 * AC coverage map (BL-308 NEW — evaluation-coordinator trigger):
 *   AC-1 (DISPOSITIVE): eligibility-engine 404 → handler calls triggerEvaluation ONCE with
 *          correct journey_id, still returns 200 { status: 'pending_eligibility' }
 *          THIS IS THE ROOT-CAUSE TEST. MUST FAIL on current code (no trigger call exists).
 *   AC-2:  triggerEvaluation throws (coordinator 5xx/network) → handler STILL returns 200
 *          pending_eligibility (trigger failures are NON-FATAL)
 *   AC-3:  triggerEvaluation resolves with 422 dedup → handler STILL returns 200
 *          pending_eligibility (422 is non-fatal success/dedup)
 *   AC-4:  EVALUATION_COORDINATOR_URL unset → client warns, handler STILL returns 200
 *          pending_eligibility (missing env var is NON-FATAL)
 *   AC-5:  triggerEvaluation receives the REAL matched journey_id (from journey-matcher response)
 *          AND the request correlationId (not the scan_id, not null/undefined)
 *
 * Mocked modules (all 4 clients mocked at module level):
 *   ../../src/lib/journey-matcher-client.js
 *   ../../src/lib/delay-tracker-client.js
 *   ../../src/lib/eligibility-engine-client.js
 *   ../../src/lib/evaluation-coordinator-client.js  ← NEW (BL-308)
 *   @railrepay/winston-logger (shared mock instance per CLAUDE.md §6.1 #11)
 *   @railrepay/metrics-pusher (counter + histogram mocked)
 *
 * Infrastructure Package Mocking (CLAUDE.md §6.1 #11):
 *   Shared logger instance OUTSIDE vi.mock factory to guarantee same object in assertions.
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture
 *   ADR-028 — On-demand evaluation trigger via evaluation-coordinator (BL-308)
 *   CLAUDE.md §6.1 — Test Specification Guidelines
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  VALID_CHECK_DELAY_BODY,
  VALID_CHECK_DELAY_BODY_RETURN,
  MATCHED_JOURNEY_ID,
  SECOND_JOURNEY_ID,
  JM_MATCH_RESPONSE_DELAYED,
  JM_MATCH_RESPONSE_ON_TIME,
  JM_NO_MATCH_RESPONSE,
  JM_NO_MATCH_RESPONSE_ROUTE,
  DT_DELAYED_RESPONSE,
  DT_ON_TIME_RESPONSE,
  DT_CANCELLED_RESPONSE,
  DT_PENDING_RESPONSE,
  JM_MATCH_RESPONSE_DELAYED as JM_MATCH_RESPONSE_CANCELLED,
  EE_ELIGIBLE_RESPONSE,
  EE_INELIGIBLE_RESPONSE,
  EE_CANCELLED_ELIGIBLE_RESPONSE,
  CHECK_DELAY_USER,
  CORRELATION_ID_001,
  CORRELATION_ID_002,
} from '../../fixtures/check-delay-data.js';

// ─── AC-14/15: Infrastructure Package Mocking (CLAUDE.md §6.1 #11) ──────────
// Shared logger instance OUTSIDE factory — same object in all assertions.
const sharedLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

// Shared metrics mocks
// Pattern updated from getOrCreate* (non-existent) to getRegistry+Counter+Histogram
// per Blake's refactor at commit 0a4b8c7. Behavioral assertion (counter.inc +
// histogram.observe called per outcome) is UNCHANGED.
// Self-fix per TD-AUTH-003-3 procedure applied during US-4 re-verification.
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

// ─── Client mocks — vi.mock hoisted before imports ───────────────────────────

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

// BL-308: evaluation-coordinator-client mock
// Module does NOT exist yet (TDD RED phase) — Blake creates it in T2-impl.
const mockTriggerEvaluation = vi.fn();
vi.mock('../../../src/lib/evaluation-coordinator-client.js', () => ({
  triggerEvaluation: (...args: unknown[]) => mockTriggerEvaluation(...args),
}));

// ─── App factory — imports the handler under test ────────────────────────────
// @ts-expect-error — module does not exist yet (TDD RED phase)
const { createCheckDelayHandler } = await import('../../../src/handlers/check-delay.handler.js');

/**
 * Build minimal Express app with session middleware stubbed via req.session injection.
 * This avoids Testcontainers dependency in unit tests.
 */
function buildApp(sessionUserId: string | null = CHECK_DELAY_USER.user_id) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  // Inject session via middleware (bypasses Redis in unit tests)
  app.use((req: any, _res: any, next: any) => {
    if (sessionUserId !== null) {
      req.session = {
        user_id: sessionUserId,
        session_id: CHECK_DELAY_USER.session_id,
        source: 'cookie' as const,
      };
    }
    // No session when null — simulates unauthenticated request
    next();
  });

  app.post('/api/journeys/check-delay', createCheckDelayHandler());
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-005: check-delay handler unit tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── AC-2: Authentication ─────────────────────────────────────────────────

  describe('AC-2: Authentication — no session returns 401', () => {
    it('should return 401 { error: "unauthorized" } when no session is present', async () => {
      // AC-2: No session injected
      const app = buildApp(null);

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: 'unauthorized' });

      // AC-2: No upstream calls made when unauthenticated
      expect(mockMatchJourney).not.toHaveBeenCalled();
      expect(mockQueryDelay).not.toHaveBeenCalled();
      expect(mockGetEligibility).not.toHaveBeenCalled();
    });
  });

  // ─── AC-1: Body Validation ────────────────────────────────────────────────

  describe('AC-1: Body validation — missing required fields → 400 with field-level details', () => {
    it('should return 400 when origin_station is missing', async () => {
      const app = buildApp();
      const { origin_station: _, ...bodyWithoutOrigin } = VALID_CHECK_DELAY_BODY;

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(bodyWithoutOrigin);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'validation_error' });
      expect(res.body.details).toBeDefined();
      // AC-1: Field-level details must reference the missing field
      const detailsStr = JSON.stringify(res.body.details);
      expect(detailsStr).toContain('origin_station');

      // AC-1: No upstream calls on validation failure
      expect(mockMatchJourney).not.toHaveBeenCalled();
    });

    it('should return 400 when destination_station is missing', async () => {
      const app = buildApp();
      const { destination_station: _, ...bodyWithoutDest } = VALID_CHECK_DELAY_BODY;

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(bodyWithoutDest);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'validation_error' });
      const detailsStr = JSON.stringify(res.body.details);
      expect(detailsStr).toContain('destination_station');
    });

    it('should return 400 when departure_date is missing', async () => {
      const app = buildApp();
      const { departure_date: _, ...bodyWithoutDate } = VALID_CHECK_DELAY_BODY;

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(bodyWithoutDate);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'validation_error' });
    });

    it('should return 400 when departure_time is missing', async () => {
      const app = buildApp();
      const { departure_time: _, ...bodyWithoutTime } = VALID_CHECK_DELAY_BODY;

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(bodyWithoutTime);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'validation_error' });
    });

    it('should return 400 when departure_date has wrong format (not YYYY-MM-DD)', async () => {
      const app = buildApp();

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send({ ...VALID_CHECK_DELAY_BODY, departure_date: '12-05-2026' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'validation_error' });
    });

    it('should return 400 when departure_time has wrong format (not HH:MM)', async () => {
      const app = buildApp();

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send({ ...VALID_CHECK_DELAY_BODY, departure_time: '9:30am' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'validation_error' });
    });

    it('should return 400 when request body is empty', async () => {
      const app = buildApp();

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'validation_error' });
    });
  });

  // ─── AC-3: Happy path — matched + delayed ────────────────────────────────

  describe('AC-3: Happy path — matched + delayed → 200 flat composite', () => {
    it('should return 200 with merged journey + delay + eligibility data on delayed match', async () => {
      // AC-3: All three clients succeed — full composite
      mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_MATCH_RESPONSE_DELAYED });
      mockQueryDelay.mockResolvedValueOnce({ statusCode: 200, body: DT_DELAYED_RESPONSE });
      mockGetEligibility.mockResolvedValueOnce({ statusCode: 200, body: EE_ELIGIBLE_RESPONSE });

      const app = buildApp();
      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      expect(res.status).toBe(200);

      // AC-3: Flat composite shape — journey data present
      expect(res.body.matched).toBe(true);
      expect(res.body.journey_id).toBe(MATCHED_JOURNEY_ID);

      // AC-3: Delay data present
      expect(res.body.delay_minutes).toBe(23);
      expect(res.body.cancelled).toBe(false);
      expect(res.body.status).toBe('delayed');
      expect(res.body.last_observed_at).toBeDefined();

      // AC-3: Eligibility data present
      expect(res.body.eligible).toBe(true);
      expect(res.body.scheme).toBe('DR15');
      expect(res.body.compensation_pence).toBe(2238);
      expect(res.body.compensation_percentage).toBe(25);
      expect(res.body.reasons).toEqual(EE_ELIGIBLE_RESPONSE.reasons);
      expect(res.body.applied_rules).toEqual(EE_ELIGIBLE_RESPONSE.applied_rules);

      // AC-3: All three upstreams called in sequence
      expect(mockMatchJourney).toHaveBeenCalledOnce();
      expect(mockQueryDelay).toHaveBeenCalledOnce();
      expect(mockGetEligibility).toHaveBeenCalledOnce();
    });

    it('AC-3: user_id comes from session (NOT request body)', async () => {
      // AC-3 + session contract: user_id must come from req.session.user_id
      mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_MATCH_RESPONSE_DELAYED });
      mockQueryDelay.mockResolvedValueOnce({ statusCode: 200, body: DT_DELAYED_RESPONSE });
      mockGetEligibility.mockResolvedValueOnce({ statusCode: 200, body: EE_ELIGIBLE_RESPONSE });

      const app = buildApp(CHECK_DELAY_USER.user_id);

      // Body deliberately does NOT contain user_id
      const bodyWithoutUserId = { ...VALID_CHECK_DELAY_BODY };
      expect(bodyWithoutUserId).not.toHaveProperty('user_id');

      await request(app)
        .post('/api/journeys/check-delay')
        .send(bodyWithoutUserId);

      // Verify journey-matcher was called with session user_id injected
      const jmCallArgs = mockMatchJourney.mock.calls[0];
      expect(jmCallArgs).toBeDefined();
      // The client call should include user_id from session
      const callArg = jmCallArgs[0] as Record<string, unknown>;
      expect(callArg.user_id).toBe(CHECK_DELAY_USER.user_id);
    });
  });

  // ─── AC-4: Happy path — matched + on_time ────────────────────────────────

  describe('AC-4: Happy path — matched + on_time → 200 with delay_minutes=0', () => {
    it('should return 200 with on_time status and eligibility verdict', async () => {
      // AC-4: Different journey ID and different mock responses for uniqueness
      mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_MATCH_RESPONSE_ON_TIME });
      mockQueryDelay.mockResolvedValueOnce({ statusCode: 200, body: DT_ON_TIME_RESPONSE });
      mockGetEligibility.mockResolvedValueOnce({ statusCode: 200, body: EE_INELIGIBLE_RESPONSE });

      const app = buildApp();
      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_002)
        .send(VALID_CHECK_DELAY_BODY_RETURN);

      expect(res.status).toBe(200);
      expect(res.body.matched).toBe(true);
      expect(res.body.journey_id).toBe(SECOND_JOURNEY_ID);

      // AC-4: on_time specific assertions
      expect(res.body.delay_minutes).toBe(0);
      expect(res.body.cancelled).toBe(false);
      expect(res.body.status).toBe('on_time');

      // AC-4: Eligibility still evaluated on on_time (ineligible because below threshold)
      expect(res.body.eligible).toBe(false);
      expect(res.body.compensation_pence).toBe(0);
    });
  });

  // ─── AC-5: Happy path — matched + cancelled ──────────────────────────────

  describe('AC-5: Happy path — matched + cancelled → 200 with cancelled=true', () => {
    it('should return 200 with cancelled status and eligibility verdict', async () => {
      // AC-5: Uses CANCELLED response fixture (distinct journey_id + cancelled=true)
      mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_MATCH_RESPONSE_CANCELLED });
      mockQueryDelay.mockResolvedValueOnce({ statusCode: 200, body: DT_CANCELLED_RESPONSE });
      mockGetEligibility.mockResolvedValueOnce({ statusCode: 200, body: EE_CANCELLED_ELIGIBLE_RESPONSE });

      const app = buildApp();
      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      expect(res.status).toBe(200);
      expect(res.body.matched).toBe(true);

      // AC-5: Cancelled-specific assertions
      expect(res.body.cancelled).toBe(true);
      expect(res.body.status).toBe('cancelled');

      // AC-5: Eligibility verdict present for cancelled journey (100% refund)
      expect(res.body.eligible).toBe(true);
      expect(res.body.compensation_percentage).toBe(100);

      // AC-5: All three upstreams called (cancellation still hits eligibility-engine)
      expect(mockMatchJourney).toHaveBeenCalledOnce();
      expect(mockQueryDelay).toHaveBeenCalledOnce();
      expect(mockGetEligibility).toHaveBeenCalledOnce();
    });
  });

  // ─── AC-6: No-match path ─────────────────────────────────────────────────

  describe('AC-6: No-match path — journey-matcher returns no_match', () => {
    it('should return 200 { matched: false, journey_id: null, reason } and NOT call delay-tracker or eligibility-engine', async () => {
      // AC-6: journey-matcher returns no_match
      mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_NO_MATCH_RESPONSE });

      const app = buildApp();
      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      expect(res.status).toBe(200);
      expect(res.body.matched).toBe(false);
      expect(res.body.journey_id).toBeNull();
      expect(res.body.reason).toBe('station_resolution_failed');
      expect(res.body.detail).toBeDefined();

      // AC-6: MUST NOT call downstream services after no_match
      expect(mockQueryDelay).not.toHaveBeenCalled();
      expect(mockGetEligibility).not.toHaveBeenCalled();
    });

    it('should return 200 { matched: false } for no_route_found variant', async () => {
      // AC-6: Different no_match reason for coverage of reason field
      mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_NO_MATCH_RESPONSE_ROUTE });

      const app = buildApp();
      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_002)
        .send(VALID_CHECK_DELAY_BODY);

      expect(res.status).toBe(200);
      expect(res.body.matched).toBe(false);
      expect(res.body.journey_id).toBeNull();
      expect(res.body.reason).toBe('no_route_found');

      expect(mockQueryDelay).not.toHaveBeenCalled();
      expect(mockGetEligibility).not.toHaveBeenCalled();
    });
  });

  // ─── AC-7: Eventual consistency — delay-tracker 404 ─────────────────────

  describe('AC-7: Eventual consistency — delay-tracker 404 after match (race condition)', () => {
    it('should return 200 { status: "pending" } and NOT call eligibility-engine when delay-tracker returns 404', async () => {
      // AC-7: journey-matcher matches but delay-tracker hasn't ingested yet
      mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_MATCH_RESPONSE_DELAYED });
      mockQueryDelay.mockResolvedValueOnce({ statusCode: 404, body: { error: 'unknown_journey' } });

      const app = buildApp();
      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      expect(res.status).toBe(200);
      expect(res.body.matched).toBe(true);
      expect(res.body.journey_id).toBe(MATCHED_JOURNEY_ID);
      expect(res.body.status).toBe('pending');
      expect(res.body.message).toBeDefined();
      expect(typeof res.body.message).toBe('string');
      expect(res.body.message.length).toBeGreaterThan(0);

      // AC-7: MUST NOT call eligibility-engine when delay-tracker returns 404
      expect(mockGetEligibility).not.toHaveBeenCalled();

      // AC-7: delay-tracker WAS called (we just got 404 from it)
      expect(mockQueryDelay).toHaveBeenCalledOnce();
    });
  });

  // ─── AC-8: Eventual consistency — eligibility-engine 404 ────────────────

  describe('AC-8: Eventual consistency — eligibility-engine 404 after delay data received', () => {
    it('should return 200 with delay data present and status indicating pending eligibility when eligibility-engine returns 404', async () => {
      // AC-8: journey-matcher + delay-tracker succeed; eligibility-engine not yet evaluated
      mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_MATCH_RESPONSE_DELAYED });
      mockQueryDelay.mockResolvedValueOnce({ statusCode: 200, body: DT_DELAYED_RESPONSE });
      mockGetEligibility.mockResolvedValueOnce({ statusCode: 404, body: { error: 'Evaluation not found', journey_id: MATCHED_JOURNEY_ID } });

      const app = buildApp();
      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      expect(res.status).toBe(200);
      expect(res.body.matched).toBe(true);
      expect(res.body.journey_id).toBe(MATCHED_JOURNEY_ID);

      // AC-8: Delay data MUST be present (we got it from delay-tracker)
      expect(res.body.delay_minutes).toBe(23);
      expect(res.body.cancelled).toBe(false);
      expect(res.body.status).toMatch(/pending/); // 'pending_eligibility' or similar

      // AC-8: Eligibility verdict absent (404 from eligibility-engine)
      expect(res.body.eligible).toBeUndefined();
      expect(res.body.compensation_pence).toBeUndefined();

      // AC-8: All three upstreams were called
      expect(mockMatchJourney).toHaveBeenCalledOnce();
      expect(mockQueryDelay).toHaveBeenCalledOnce();
      expect(mockGetEligibility).toHaveBeenCalledOnce();
    });
  });

  // ─── AC-9: journey-matcher upstream error ────────────────────────────────

  describe('AC-9: journey-matcher 503/timeout → 503 with service indicator', () => {
    it('should return 503 { error: "upstream_unavailable", service: "journey-matcher" } when journey-matcher returns 503', async () => {
      // AC-9: journey-matcher signals unavailability
      mockMatchJourney.mockResolvedValueOnce({
        statusCode: 503,
        body: { error: 'upstream_unavailable' },
      });

      const app = buildApp();
      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        error: 'upstream_unavailable',
        service: 'journey-matcher',
      });

      // AC-9: downstream services NOT called after journey-matcher failure
      expect(mockQueryDelay).not.toHaveBeenCalled();
      expect(mockGetEligibility).not.toHaveBeenCalled();
    });

    it('should return 503 when journey-matcher client throws timeout error', async () => {
      // AC-9: Network timeout / AbortError from client
      mockMatchJourney.mockRejectedValueOnce(new Error('AbortError'));

      const app = buildApp();
      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        error: 'upstream_unavailable',
        service: 'journey-matcher',
      });
    });
  });

  // ─── AC-10: delay-tracker upstream error ─────────────────────────────────

  describe('AC-10: delay-tracker 503/timeout → 503 with service indicator', () => {
    it('should return 503 { error: "upstream_unavailable", service: "delay-tracker" } when delay-tracker returns 503', async () => {
      // AC-10: journey-matcher succeeds; delay-tracker signals unavailability
      mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_MATCH_RESPONSE_DELAYED });
      mockQueryDelay.mockResolvedValueOnce({
        statusCode: 503,
        body: { error: 'upstream_unavailable' },
      });

      const app = buildApp();
      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        error: 'upstream_unavailable',
        service: 'delay-tracker',
      });

      // AC-10: eligibility-engine NOT called after delay-tracker failure
      expect(mockGetEligibility).not.toHaveBeenCalled();
    });

    it('should return 503 when delay-tracker client throws timeout error', async () => {
      // AC-10: Network timeout / AbortError from delay-tracker client
      mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_MATCH_RESPONSE_DELAYED });
      mockQueryDelay.mockRejectedValueOnce(new Error('AbortError'));

      const app = buildApp();
      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        error: 'upstream_unavailable',
        service: 'delay-tracker',
      });
    });
  });

  // ─── AC-11: eligibility-engine upstream error ─────────────────────────────

  describe('AC-11: eligibility-engine 503/timeout → 503 with service indicator', () => {
    it('should return 503 { error: "upstream_unavailable", service: "eligibility-engine" } when eligibility-engine returns 503', async () => {
      // AC-11: journey-matcher + delay-tracker succeed; eligibility-engine unavailable
      mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_MATCH_RESPONSE_DELAYED });
      mockQueryDelay.mockResolvedValueOnce({ statusCode: 200, body: DT_DELAYED_RESPONSE });
      mockGetEligibility.mockResolvedValueOnce({
        statusCode: 503,
        body: { error: 'upstream_unavailable' },
      });

      const app = buildApp();
      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        error: 'upstream_unavailable',
        service: 'eligibility-engine',
      });
    });

    it('should return 503 when eligibility-engine client throws timeout error', async () => {
      // AC-11: Network timeout from eligibility-engine client
      mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_MATCH_RESPONSE_DELAYED });
      mockQueryDelay.mockResolvedValueOnce({ statusCode: 200, body: DT_DELAYED_RESPONSE });
      mockGetEligibility.mockRejectedValueOnce(new Error('AbortError'));

      const app = buildApp();
      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        error: 'upstream_unavailable',
        service: 'eligibility-engine',
      });
    });
  });

  // ─── AC-12: delay-tracker 403 defense-in-depth ───────────────────────────

  describe('AC-12: delay-tracker 403 (defense-in-depth) → 500', () => {
    it('should return 500 when delay-tracker returns 403 (should never happen but must be handled)', async () => {
      // AC-12: 403 from delay-tracker = user_id mismatch (BFF supplies user_id from session, so this SHOULD NOT happen)
      // Defense-in-depth: handle it anyway
      mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_MATCH_RESPONSE_DELAYED });
      mockQueryDelay.mockResolvedValueOnce({
        statusCode: 403,
        body: { error: 'forbidden' },
      });

      const app = buildApp();
      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      // AC-12: Unexpected 403 from internal service = 500 (internal error)
      expect(res.status).toBe(500);

      // AC-12: eligibility-engine MUST NOT be called after 403
      expect(mockGetEligibility).not.toHaveBeenCalled();
    });
  });

  // ─── AC-14: Logging ──────────────────────────────────────────────────────

  describe('AC-14: Structured logging per request with outcome', () => {
    it('should emit a structured log on successful composite request', async () => {
      // AC-14: Happy path — expect at least one info log with outcome
      mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_MATCH_RESPONSE_DELAYED });
      mockQueryDelay.mockResolvedValueOnce({ statusCode: 200, body: DT_DELAYED_RESPONSE });
      mockGetEligibility.mockResolvedValueOnce({ statusCode: 200, body: EE_ELIGIBLE_RESPONSE });

      const app = buildApp();
      await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      // AC-14: At least one structured log must have been emitted
      const allCalls = [
        ...sharedLogger.info.mock.calls,
        ...sharedLogger.warn.mock.calls,
        ...sharedLogger.error.mock.calls,
      ];
      expect(allCalls.length).toBeGreaterThan(0);
    });

    it('should log outcome on error (503 from journey-matcher)', async () => {
      // AC-14: Error path also logs
      mockMatchJourney.mockResolvedValueOnce({ statusCode: 503, body: {} });

      const app = buildApp();
      await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      const allCalls = [
        ...sharedLogger.info.mock.calls,
        ...sharedLogger.warn.mock.calls,
        ...sharedLogger.error.mock.calls,
      ];
      expect(allCalls.length).toBeGreaterThan(0);
    });
  });

  // ─── AC-15: Metrics ──────────────────────────────────────────────────────

  describe('AC-15: Prometheus counter + histogram updated per outcome', () => {
    it('should increment counter and observe histogram on successful request', async () => {
      // AC-15: Full happy path → metrics updated with outcome label
      mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_MATCH_RESPONSE_DELAYED });
      mockQueryDelay.mockResolvedValueOnce({ statusCode: 200, body: DT_DELAYED_RESPONSE });
      mockGetEligibility.mockResolvedValueOnce({ statusCode: 200, body: EE_ELIGIBLE_RESPONSE });

      const app = buildApp();
      await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      // AC-15: counter `web_app_bff_check_delay_total{outcome=}` incremented
      expect(mockCounter.inc).toHaveBeenCalled();
      // AC-15: histogram `web_app_bff_check_delay_duration_seconds` observed
      expect(mockHistogram.observe).toHaveBeenCalled();
    });

    it('should increment counter on error outcome (upstream_unavailable)', async () => {
      // AC-15: Error outcome also records metrics
      mockMatchJourney.mockResolvedValueOnce({ statusCode: 503, body: {} });

      const app = buildApp();
      await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      expect(mockCounter.inc).toHaveBeenCalled();
      expect(mockHistogram.observe).toHaveBeenCalled();
    });
  });

  // ─── BL-308: Evaluation-coordinator trigger (NEW) ─────────────────────────
  //
  // Root cause (Blake T1, 2026-05-28): when eligibility-engine returns 404 on
  // an on-demand check-delay, the BFF returned pending_eligibility but NEVER
  // fired POST /evaluate/:journeyId on the evaluation-coordinator. Consequence:
  // the poll window exhausted without a verdict.
  //
  // Fix (ADR-028, Option A): on eligibility-engine 404, fire triggerEvaluation()
  // fire-and-forget BEFORE returning 200 pending_eligibility. All trigger outcomes
  // (202, 422 dedup, 5xx, network error, missing env var) MUST be NON-FATAL.

  describe('BL-308: evaluation-coordinator trigger when eligibility-engine returns 404', () => {

    // ── AC-1 (DISPOSITIVE) ──────────────────────────────────────────────────
    //
    // THIS IS THE ROOT-CAUSE TEST.
    // It MUST FAIL on current code (no triggerEvaluation call exists in handler).
    // Blake's GREEN must flip it by calling triggerEvaluation in the AC-8 branch.

    describe('AC-1 (DISPOSITIVE-RED): handler calls triggerEvaluation on eligibility-engine 404', () => {
      it('AC-1 DISPOSITIVE: should call triggerEvaluation ONCE with matched journey_id when eligibility-engine returns 404', async () => {
        // DISPOSITIVE-RED: This test MUST FAIL on current handler code.
        // Current handler returns 200 pending_eligibility WITHOUT calling triggerEvaluation.
        // Blake's fix: add triggerEvaluation(journeyId, correlationId) (fire-and-forget)
        // inside the eligibility-engine 404 branch BEFORE the res.status(200).json call.

        mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_MATCH_RESPONSE_DELAYED });
        mockQueryDelay.mockResolvedValueOnce({ statusCode: 200, body: DT_DELAYED_RESPONSE });
        mockGetEligibility.mockResolvedValueOnce({ statusCode: 404, body: { error: 'Evaluation not found', journey_id: MATCHED_JOURNEY_ID } });
        // triggerEvaluation resolves (fire-and-forget 202)
        mockTriggerEvaluation.mockResolvedValueOnce(undefined);

        const app = buildApp();
        const res = await request(app)
          .post('/api/journeys/check-delay')
          .set('x-correlation-id', CORRELATION_ID_001)
          .send(VALID_CHECK_DELAY_BODY);

        // AC-1: Handler still returns 200 pending_eligibility (trigger is fire-and-forget)
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('pending_eligibility');
        expect(res.body.matched).toBe(true);
        expect(res.body.journey_id).toBe(MATCHED_JOURNEY_ID);
        // AC-1: Delay data still present (not dropped by trigger path)
        expect(res.body.delay_minutes).toBe(23);

        // AC-1 DISPOSITIVE ASSERTION: triggerEvaluation MUST have been called EXACTLY ONCE
        // This is the assertion that FAILS on current code (current code never calls it).
        expect(mockTriggerEvaluation).toHaveBeenCalledOnce();
      });

      it('AC-1: triggerEvaluation should NOT be called when eligibility-engine returns 200 (happy path)', async () => {
        // AC-1 boundary: trigger is ONLY fired on 404, not on successful eligibility response
        mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_MATCH_RESPONSE_DELAYED });
        mockQueryDelay.mockResolvedValueOnce({ statusCode: 200, body: DT_DELAYED_RESPONSE });
        mockGetEligibility.mockResolvedValueOnce({ statusCode: 200, body: EE_ELIGIBLE_RESPONSE });

        const app = buildApp();
        await request(app)
          .post('/api/journeys/check-delay')
          .set('x-correlation-id', CORRELATION_ID_001)
          .send(VALID_CHECK_DELAY_BODY);

        // AC-1: MUST NOT trigger evaluation when eligibility-engine already has a result
        expect(mockTriggerEvaluation).not.toHaveBeenCalled();
      });

      it('AC-1: triggerEvaluation should NOT be called when delay-tracker returns 404 (pending step)', async () => {
        // AC-1 boundary: trigger only fires when delay IS available but eligibility is missing
        mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_MATCH_RESPONSE_DELAYED });
        mockQueryDelay.mockResolvedValueOnce({ statusCode: 404, body: { error: 'unknown_journey' } });

        const app = buildApp();
        await request(app)
          .post('/api/journeys/check-delay')
          .set('x-correlation-id', CORRELATION_ID_001)
          .send(VALID_CHECK_DELAY_BODY);

        // AC-1: MUST NOT trigger evaluation when delay data is not yet available
        expect(mockTriggerEvaluation).not.toHaveBeenCalled();
      });
    });

    // ── AC-5: correct journey_id and correlationId forwarded ────────────────

    describe('AC-5: triggerEvaluation receives the REAL matched journey_id and request correlationId', () => {
      it('AC-5: should call triggerEvaluation with journey_id from journey-matcher (not scan_id, not null)', async () => {
        // AC-5: journey_id must come from the journey-matcher response, not the request body's scan_id
        mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_MATCH_RESPONSE_DELAYED });
        mockQueryDelay.mockResolvedValueOnce({ statusCode: 200, body: DT_DELAYED_RESPONSE });
        mockGetEligibility.mockResolvedValueOnce({ statusCode: 404, body: { error: 'Evaluation not found', journey_id: MATCHED_JOURNEY_ID } });
        mockTriggerEvaluation.mockResolvedValueOnce(undefined);

        const app = buildApp();
        await request(app)
          .post('/api/journeys/check-delay')
          .set('x-correlation-id', CORRELATION_ID_001)
          .send(VALID_CHECK_DELAY_BODY);

        // AC-5: First argument must be the REAL journey_id (MATCHED_JOURNEY_ID)
        expect(mockTriggerEvaluation).toHaveBeenCalledOnce();
        const [calledJourneyId, calledCorrelationId] = mockTriggerEvaluation.mock.calls[0] as [string, string | undefined];
        expect(calledJourneyId).toBe(MATCHED_JOURNEY_ID);

        // AC-5: Second argument must be the request correlationId (x-correlation-id header)
        expect(calledCorrelationId).toBe(CORRELATION_ID_001);
      });

      it('AC-5: different journeyIds (from different journey-matcher responses) are forwarded correctly', async () => {
        // AC-5: triggerEvaluation must receive the journey_id from THIS request, not a stale one
        mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_MATCH_RESPONSE_ON_TIME });
        mockQueryDelay.mockResolvedValueOnce({ statusCode: 200, body: DT_ON_TIME_RESPONSE });
        mockGetEligibility.mockResolvedValueOnce({ statusCode: 404, body: { error: 'Evaluation not found', journey_id: SECOND_JOURNEY_ID } });
        mockTriggerEvaluation.mockResolvedValueOnce(undefined);

        const app = buildApp();
        await request(app)
          .post('/api/journeys/check-delay')
          .set('x-correlation-id', CORRELATION_ID_002)
          .send(VALID_CHECK_DELAY_BODY_RETURN);

        expect(mockTriggerEvaluation).toHaveBeenCalledOnce();
        const [calledJourneyId, calledCorrelationId] = mockTriggerEvaluation.mock.calls[0] as [string, string | undefined];
        // AC-5: Must receive SECOND_JOURNEY_ID (from JM_MATCH_RESPONSE_ON_TIME), not MATCHED_JOURNEY_ID
        expect(calledJourneyId).toBe(SECOND_JOURNEY_ID);
        // AC-5: Must receive CORRELATION_ID_002 from this request's header
        expect(calledCorrelationId).toBe(CORRELATION_ID_002);
      });
    });

    // ── AC-2: trigger failure (5xx / network) is NON-FATAL ───────────────────

    describe('AC-2: triggerEvaluation throws (coordinator 5xx/network) → handler still returns 200 pending_eligibility', () => {
      it('AC-2: handler returns 200 pending_eligibility even when triggerEvaluation throws (5xx)', async () => {
        // AC-2: Coordinator 5xx must NOT propagate into handler response
        // ADR-028: "All trigger outcomes MUST be NON-FATAL"
        mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_MATCH_RESPONSE_DELAYED });
        mockQueryDelay.mockResolvedValueOnce({ statusCode: 200, body: DT_DELAYED_RESPONSE });
        mockGetEligibility.mockResolvedValueOnce({ statusCode: 404, body: { error: 'Evaluation not found', journey_id: MATCHED_JOURNEY_ID } });
        // Simulate coordinator returning 5xx → client throws
        mockTriggerEvaluation.mockRejectedValueOnce(new Error('coordinator_unavailable'));

        const app = buildApp();
        const res = await request(app)
          .post('/api/journeys/check-delay')
          .set('x-correlation-id', CORRELATION_ID_001)
          .send(VALID_CHECK_DELAY_BODY);

        // AC-2: MUST NOT return 500 or 503 — trigger failure is non-fatal
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('pending_eligibility');
        expect(res.body.matched).toBe(true);
      });

      it('AC-2: handler returns 200 pending_eligibility even when triggerEvaluation throws (network error)', async () => {
        // AC-2: Network error (coordinator unreachable) must NOT propagate
        mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_MATCH_RESPONSE_DELAYED });
        mockQueryDelay.mockResolvedValueOnce({ statusCode: 200, body: DT_DELAYED_RESPONSE });
        mockGetEligibility.mockResolvedValueOnce({ statusCode: 404, body: { error: 'Evaluation not found', journey_id: MATCHED_JOURNEY_ID } });
        mockTriggerEvaluation.mockRejectedValueOnce(new Error('ECONNREFUSED'));

        const app = buildApp();
        const res = await request(app)
          .post('/api/journeys/check-delay')
          .set('x-correlation-id', CORRELATION_ID_001)
          .send(VALID_CHECK_DELAY_BODY);

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('pending_eligibility');
      });
    });

    // ── AC-3: 422 dedup is NON-FATAL ────────────────────────────────────────

    describe('AC-3: triggerEvaluation resolves with 422 dedup → handler still returns 200 pending_eligibility', () => {
      it('AC-3: handler returns 200 pending_eligibility when triggerEvaluation resolves (422 dedup case)', async () => {
        // AC-3: 422 from coordinator = evaluation already in flight
        // Client resolves (not throws) on 422; handler must still return pending_eligibility
        mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_MATCH_RESPONSE_DELAYED });
        mockQueryDelay.mockResolvedValueOnce({ statusCode: 200, body: DT_DELAYED_RESPONSE });
        mockGetEligibility.mockResolvedValueOnce({ statusCode: 404, body: { error: 'Evaluation not found', journey_id: MATCHED_JOURNEY_ID } });
        // 422 dedup: client resolves (non-throwing) per AC-3 on evaluation-coordinator-client
        mockTriggerEvaluation.mockResolvedValueOnce(undefined);

        const app = buildApp();
        const res = await request(app)
          .post('/api/journeys/check-delay')
          .set('x-correlation-id', CORRELATION_ID_001)
          .send(VALID_CHECK_DELAY_BODY);

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('pending_eligibility');
        // AC-3: triggerEvaluation was still called (even if it deduped)
        expect(mockTriggerEvaluation).toHaveBeenCalledOnce();
      });
    });

    // ── AC-4: missing EVALUATION_COORDINATOR_URL is NON-FATAL ───────────────

    describe('AC-4: EVALUATION_COORDINATOR_URL unset → handler still returns 200 pending_eligibility', () => {
      it('AC-4: handler returns 200 pending_eligibility when EVALUATION_COORDINATOR_URL is not set', async () => {
        // AC-4: Missing env var must NOT crash the handler
        // Blake's env-var testing pattern (CLAUDE.md §6.2): delete env var in test
        const originalUrl = process.env.EVALUATION_COORDINATOR_URL;
        delete process.env.EVALUATION_COORDINATOR_URL;

        // Client warns and resolves (no throw) when URL is missing (per client AC-4)
        mockMatchJourney.mockResolvedValueOnce({ statusCode: 200, body: JM_MATCH_RESPONSE_DELAYED });
        mockQueryDelay.mockResolvedValueOnce({ statusCode: 200, body: DT_DELAYED_RESPONSE });
        mockGetEligibility.mockResolvedValueOnce({ statusCode: 404, body: { error: 'Evaluation not found', journey_id: MATCHED_JOURNEY_ID } });
        // When env var missing: client warns and resolves (non-throwing)
        mockTriggerEvaluation.mockResolvedValueOnce(undefined);

        const app = buildApp();
        const res = await request(app)
          .post('/api/journeys/check-delay')
          .set('x-correlation-id', CORRELATION_ID_001)
          .send(VALID_CHECK_DELAY_BODY);

        // AC-4: MUST return 200 pending_eligibility regardless of missing env var
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('pending_eligibility');

        // Restore
        if (originalUrl !== undefined) {
          process.env.EVALUATION_COORDINATOR_URL = originalUrl;
        }
      });
    });
  });
});
