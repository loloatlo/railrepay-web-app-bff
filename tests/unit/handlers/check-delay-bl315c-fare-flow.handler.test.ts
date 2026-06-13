/**
 * Unit Tests: BFF check-delay handler — BL-315-C fare-flow (AC-3)
 *
 * Phase   : TD-1 (Jessie — Test Specification, TDD per ADR-014)
 * BL      : BL-315-C / BL-328 — eligible→compensation happy-path
 * Date    : 2026-06-13
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * AC-3 (fare flows for REAL compensation) — BFF side:
 *   The BFF check-delay.handler.ts must:
 *   a) Accept fare_pence from the request body (the PWA sends fare_pence, not
 *      ticket_fare_pence; the BFF uses fare_pence in the trigger payload).
 *   b) Forward fare_pence / ticket_fare_pence to the evaluation-coordinator
 *      triggerEvaluation() payload so the eligibility engine can compute
 *      compensation_pence correctly.
 *   c) For a request with fare_pence=29870 + delay_minutes=77 + toc GR (DR15 50%):
 *      The BFF must pass ticket_fare_pence=29870 to triggerEvaluation().
 *      The eligibility composite must carry compensation_pence=14935 back.
 *
 * The BFF handler at ~line 573 already does:
 *   ticket_fare_pence: typeof rawBody.ticket_fare_pence === 'number'
 *     ? rawBody.ticket_fare_pence
 *     : (typeof rawBody.fare_pence === 'number' ? rawBody.fare_pence : undefined)
 * This tests that fare_pence from the PWA request IS forwarded correctly.
 *
 * Target verification service:
 *   RID 202606036701949, York→KGX 2026-06-03
 *   delay_minutes=77, toc_code='GR', DR15 50% band
 *   fare_pence=29870 → compensation_pence=Math.floor(29870*50/100)=14935
 *
 * Mocking strategy (mirrors ADR-031-ensure-on-404.handler.test.ts):
 *   - delay-tracker-client: queryDelay (returns 404) + ensureDelay (returns delayed)
 *   - journey-matcher-client: matchJourney (returns matched)
 *   - eligibility-engine-client: getEligibility (returns eligible composite)
 *   - evaluation-coordinator-client: triggerEvaluation (capturable for assertion)
 *   - @railrepay/winston-logger: shared mock instance (CLAUDE.md §6.1 #11)
 *   - @railrepay/metrics-pusher: mocked
 *
 * ADR references:
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture
 *   ADR-027 — BFF owns canonical client-facing contract
 *   ADR-031 — Synchronous ensure-on-404
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

// ─── Infrastructure package mocks (CLAUDE.md §6.1 #11) ───────────────────────

const sharedLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

vi.mock('@railrepay/metrics-pusher', () => {
  const inc = vi.fn();
  const observe = vi.fn();
  const Counter = vi.fn(() => ({ inc }));
  const Histogram = vi.fn(() => ({ observe }));
  const registry = {
    getSingleMetric: vi.fn().mockReturnValue(null),
  };
  return {
    getRegistry: vi.fn(() => registry),
    Counter,
    Histogram,
  };
});

// ─── Client mocks ─────────────────────────────────────────────────────────────

const mockMatchJourney      = vi.fn();
const mockQueryDelay        = vi.fn();
const mockEnsureDelay       = vi.fn();
const mockGetEligibility    = vi.fn();
const mockTriggerEvaluation = vi.fn();

vi.mock('../../../src/lib/journey-matcher-client.js', () => ({
  matchJourney: mockMatchJourney,
}));

vi.mock('../../../src/lib/delay-tracker-client.js', () => ({
  queryDelay:  mockQueryDelay,
  ensureDelay: mockEnsureDelay,
  DELAY_TRACKER_TIMEOUT_MS: 2000,
  ENSURE_TIMEOUT_MS: 10000,
}));

vi.mock('../../../src/lib/eligibility-engine-client.js', () => ({
  getEligibility: mockGetEligibility,
}));

vi.mock('../../../src/lib/evaluation-coordinator-client.js', () => ({
  triggerEvaluation: mockTriggerEvaluation,
}));

// ─── UUID constants ───────────────────────────────────────────────────────────

const JOURNEY_ID     = 'c315c000-0001-4000-8001-000000000001';
const USER_ID        = 'c315c000-0001-4000-8000-000000000011';
const SESSION_SID    = 'sid-c315c-0001-4000-8000-000000000001';

// ─── Helper: build Express app ────────────────────────────────────────────────

async function buildApp() {
  const { createCheckDelayHandler } = await import('../../../src/handlers/check-delay.handler.js');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, _res, next) => {
    (req as Record<string, unknown>).session = {
      user_id: USER_ID,
      session_id: SESSION_SID,
    };
    next();
  });
  app.post('/api/journeys/check-delay', createCheckDelayHandler());
  return app;
}

// ─── Request body fixtures ────────────────────────────────────────────────────

/**
 * Attested request body (post-candidate selection).
 * PWA sends fare_pence (not ticket_fare_pence — that is the eligibility DB column name).
 * actual_rid = 202606036701949 (York→KGX 07:30 GR service on 2026-06-03).
 * fare_pence = 29870 (£298.70 GR Anytime York→KGX).
 */
const ATTESTED_REQUEST_BODY = {
  origin_station: 'York',
  destination_station: 'London Kings Cross',
  departure_date: '2026-06-03',
  departure_time: '07:30',
  ticket_type: 'ANYTIME_DAY',
  fare_pence: 29870,                    // £298.70 — PWA sends fare_pence
  actual_rid: '202606036701949',
  actual_departure_time: '07:30',
};

/**
 * Same but without fare_pence — BFF trigger payload should omit ticket_fare_pence.
 */
const ATTESTED_REQUEST_NO_FARE = {
  origin_station: 'York',
  destination_station: 'London Kings Cross',
  departure_date: '2026-06-03',
  departure_time: '07:30',
  ticket_type: 'ANYTIME_DAY',
  actual_rid: '202606036701949',
  actual_departure_time: '07:30',
  // no fare_pence
};

// ─── Journey-matcher fixtures ─────────────────────────────────────────────────

const JM_MATCHED = {
  status: 'matched',
  journey_id: JOURNEY_ID,
  origin_station: 'York',
  destination_station: 'London Kings Cross',
  departure_date: '2026-06-03',
  departure_time: '07:30',
  idempotent_replay: false,
};

// ─── Delay-tracker fixtures ───────────────────────────────────────────────────

/**
 * ensure response for ADR-031 path (queryDelay returns 404 → ensureDelay called).
 * Returns 'delayed' with toc_code='GR' and delay_minutes=77.
 */
const ENSURE_DELAYED_GR = {
  journey_id: JOURNEY_ID,
  status: 'delayed',
  delay_minutes: 77,
  cancelled: false,
  toc_code: 'GR',
  last_observed_at: '2026-06-03T09:47:00.000Z',
};

/**
 * Direct GET-200 delayed response (the non-ensure path, for one test variant).
 */
const DT_DELAYED_GR = {
  journey_id: JOURNEY_ID,
  delay_minutes: 77,
  cancelled: false,
  last_observed_at: '2026-06-03T09:47:00.000Z',
  status: 'delayed',
  toc_code: 'GR',
};

// ─── Eligibility engine fixtures ──────────────────────────────────────────────

/**
 * Eligible composite from eligibility-engine for DR15 50% band.
 * compensation_pence = Math.floor(29870 * 50 / 100) = 14935.
 * ticket_fare_pence is null (nullable DB column — the production failure scenario).
 */
const EE_ELIGIBLE_NULL_FARE = {
  journey_id: JOURNEY_ID,
  eligible: true,
  scheme: 'DR15',
  delay_minutes: 77,
  compensation_percentage: 50,
  compensation_pence: 14935,     // Math.floor(29870 * 50 / 100) = 14935
  ticket_fare_pence: null,       // null — the defect: DB column is nullable
  reasons: ['Delay of 77 minutes qualifies for 50% refund under DR15'],
  applied_rules: ['DR15_60MIN_50PCT'],
  evaluation_timestamp: '2026-06-03T09:50:00.000Z',
};

/**
 * Eligible composite with fare present — regression guard.
 */
const EE_ELIGIBLE_WITH_FARE = {
  ...EE_ELIGIBLE_NULL_FARE,
  ticket_fare_pence: 29870,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('TD-BL315-C AC-3 BFF: check-delay handler — fare_pence forwarded to trigger + composite returned', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: triggerEvaluation resolves non-fatally (fire-and-forget)
    mockTriggerEvaluation.mockResolvedValue({ statusCode: 202, body: {} });
  });

  // ── AC-3a: fare_pence forwarded to triggerEvaluation on ensure path ──────────

  describe('AC-3a: fare_pence from request body forwarded as ticket_fare_pence in triggerEvaluation payload (ensure path)', () => {

    it('AC-3a: triggerEvaluation receives ticket_fare_pence=29870 when request has fare_pence=29870 (ensure path)', async () => {
      /**
       * Flow: queryDelay → 404 → ensureDelay → 'delayed'
       *       → getEligibility → 404 → triggerEvaluation fired with fare data
       *
       * The BFF handler at ~line 455-457 builds the triggerPayload:
       *   ticket_fare_pence: typeof rawBody.ticket_fare_pence === 'number'
       *     ? rawBody.ticket_fare_pence
       *     : (typeof rawBody.fare_pence === 'number' ? rawBody.fare_pence : undefined)
       * PWA sends fare_pence (not ticket_fare_pence) → fallback branch picks it up.
       * This test verifies the fallback works for fare_pence=29870.
       *
       * RED scenario: if the BFF drops fare_pence (bug), triggerEvaluation would
       * receive ticket_fare_pence=undefined → eligibility engine computes £0.00.
       */
      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: JM_MATCHED });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: {} });   // triggers ensure path
      mockEnsureDelay.mockResolvedValue({ statusCode: 200, body: ENSURE_DELAYED_GR });
      mockGetEligibility.mockResolvedValue({ statusCode: 404, body: {} }); // triggers fire-and-forget
      mockTriggerEvaluation.mockResolvedValue({ statusCode: 202, body: {} });

      const app = await buildApp();
      await request(app)
        .post('/api/journeys/check-delay')
        .send(ATTESTED_REQUEST_BODY)
        .expect(200);

      // triggerEvaluation must have been called with ticket_fare_pence=29870
      expect(mockTriggerEvaluation).toHaveBeenCalledTimes(1);
      const [, , triggerPayload] = mockTriggerEvaluation.mock.calls[0] as [string, string, Record<string, unknown>];
      expect(triggerPayload['ticket_fare_pence']).toBe(29870);
    });

    it('AC-3a: triggerEvaluation does NOT receive ticket_fare_pence when fare_pence absent from request', async () => {
      /**
       * When fare is not sent, the trigger payload should omit ticket_fare_pence.
       * Regression guard: ensure the fare-forwarding does not introduce a regression
       * for requests that legitimately omit fare.
       */
      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: JM_MATCHED });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: {} });
      mockEnsureDelay.mockResolvedValue({ statusCode: 200, body: ENSURE_DELAYED_GR });
      mockGetEligibility.mockResolvedValue({ statusCode: 404, body: {} });
      mockTriggerEvaluation.mockResolvedValue({ statusCode: 202, body: {} });

      const app = await buildApp();
      await request(app)
        .post('/api/journeys/check-delay')
        .send(ATTESTED_REQUEST_NO_FARE)
        .expect(200);

      expect(mockTriggerEvaluation).toHaveBeenCalledTimes(1);
      const [, , triggerPayload] = mockTriggerEvaluation.mock.calls[0] as [string, string, Record<string, unknown>];
      // No fare_pence in request → ticket_fare_pence should be absent/undefined in trigger
      expect(triggerPayload['ticket_fare_pence']).toBeUndefined();
    });
  });

  // ── AC-3b: fare_pence forwarded to triggerEvaluation on non-ensure path ──────

  describe('AC-3b: fare_pence forwarded to triggerEvaluation on GET-success (non-ensure) path', () => {

    it('AC-3b: triggerEvaluation receives ticket_fare_pence=29870 on GET-success → pending_eligibility path', async () => {
      /**
       * Non-ensure path: queryDelay returns 200 (row exists), getEligibility 404
       * → BFF fires triggerEvaluation with fare data from the request body.
       * Handler at ~line 572-574:
       *   ticket_fare_pence: typeof rawBody.ticket_fare_pence === 'number'
       *     ? rawBody.ticket_fare_pence
       *     : (typeof rawBody.fare_pence === 'number' ? rawBody.fare_pence : undefined)
       */
      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: JM_MATCHED });
      mockQueryDelay.mockResolvedValue({ statusCode: 200, body: DT_DELAYED_GR });  // GET success
      mockGetEligibility.mockResolvedValue({ statusCode: 404, body: {} });         // triggers trigger
      mockTriggerEvaluation.mockResolvedValue({ statusCode: 202, body: {} });

      const app = await buildApp();
      await request(app)
        .post('/api/journeys/check-delay')
        .send(ATTESTED_REQUEST_BODY)
        .expect(200);

      expect(mockTriggerEvaluation).toHaveBeenCalledTimes(1);
      const [, , triggerPayload] = mockTriggerEvaluation.mock.calls[0] as [string, string, Record<string, unknown>];
      expect(triggerPayload['ticket_fare_pence']).toBe(29870);
    });
  });

  // ── AC-3c: full composite with eligible:true returned to PWA ─────────────────

  describe('AC-3c: BFF returns full eligible composite (compensation_pence=14935) to PWA', () => {

    it('AC-3c: BFF response body contains compensation_pence=14935 for eligible composite (ensure path)', async () => {
      /**
       * End-to-end fare-flow test at the BFF boundary:
       * Request: fare_pence=29870, delay=77, toc=GR
       * → ensure path → getEligibility returns EE_ELIGIBLE_NULL_FARE (null fare, 14935 comp)
       * → BFF assembles full composite → response.body.compensation_pence=14935
       *
       * This verifies the composite building in the handler correctly passes through
       * eeBody.compensation_pence from the eligibility engine.
       */
      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: JM_MATCHED });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: {} });
      mockEnsureDelay.mockResolvedValue({ statusCode: 200, body: ENSURE_DELAYED_GR });
      // Eligibility engine returns immediately (200 — already computed)
      mockGetEligibility.mockResolvedValue({ statusCode: 200, body: EE_ELIGIBLE_NULL_FARE });

      const app = await buildApp();
      const response = await request(app)
        .post('/api/journeys/check-delay')
        .send(ATTESTED_REQUEST_BODY)
        .expect(200);

      expect(response.body.eligible).toBe(true);
      expect(response.body.compensation_pence).toBe(14935);
      expect(response.body.scheme).toBe('DR15');
    });

    it('AC-3c: BFF response body has ticket_fare_pence=null when eligibility engine returns null (passes through)', async () => {
      /**
       * The BFF handler at ~line 500:
       *   ticket_fare_pence: eeBody.ticket_fare_pence,
       * When eeBody.ticket_fare_pence is null, this PASSES null through to the response.
       * The PWA schema must accept null (AC-1 fix). This test documents that the BFF
       * correctly passes null through rather than converting it.
       */
      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: JM_MATCHED });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: {} });
      mockEnsureDelay.mockResolvedValue({ statusCode: 200, body: ENSURE_DELAYED_GR });
      mockGetEligibility.mockResolvedValue({ statusCode: 200, body: EE_ELIGIBLE_NULL_FARE });

      const app = await buildApp();
      const response = await request(app)
        .post('/api/journeys/check-delay')
        .send(ATTESTED_REQUEST_BODY)
        .expect(200);

      // BFF passes null through — PWA schema must accept it (AC-1)
      expect(response.body.ticket_fare_pence).toBeNull();
    });

    it('AC-3c: BFF response body has ticket_fare_pence=29870 when eligibility engine returns 29870', async () => {
      /**
       * Regression guard: when the DB has the fare, it should flow through correctly.
       */
      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: JM_MATCHED });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: {} });
      mockEnsureDelay.mockResolvedValue({ statusCode: 200, body: ENSURE_DELAYED_GR });
      mockGetEligibility.mockResolvedValue({ statusCode: 200, body: EE_ELIGIBLE_WITH_FARE });

      const app = await buildApp();
      const response = await request(app)
        .post('/api/journeys/check-delay')
        .send(ATTESTED_REQUEST_BODY)
        .expect(200);

      expect(response.body.ticket_fare_pence).toBe(29870);
      expect(response.body.compensation_pence).toBe(14935);
    });

    it('AC-3c: BFF returns eligible:true and delay_minutes=77 in full composite (ensure path)', async () => {
      /**
       * Full composite fields verification for the target verification service.
       */
      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: JM_MATCHED });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: {} });
      mockEnsureDelay.mockResolvedValue({ statusCode: 200, body: ENSURE_DELAYED_GR });
      mockGetEligibility.mockResolvedValue({ statusCode: 200, body: EE_ELIGIBLE_NULL_FARE });

      const app = await buildApp();
      const response = await request(app)
        .post('/api/journeys/check-delay')
        .send(ATTESTED_REQUEST_BODY)
        .expect(200);

      expect(response.body.matched).toBe(true);
      expect(response.body.eligible).toBe(true);
      expect(response.body.delay_minutes).toBe(77);
      expect(response.body.compensation_percentage).toBe(50);
      expect(response.body.journey_id).toBe(JOURNEY_ID);
    });
  });

  // ── AC-3d: fare_pence in GET-success path composite ──────────────────────────

  describe('AC-3d: BFF returns eligible composite via GET-success path (non-ensure) with correct compensation', () => {

    it('AC-3d: BFF returns compensation_pence=14935 for GET-success path with EE eligible response', async () => {
      /**
       * The non-ensure path: queryDelay returns 200, getEligibility returns 200.
       * The handler at ~lines 598-627 assembles the composite from delayBody + eeBody.
       * compensation_pence must pass through from eeBody correctly.
       */
      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: JM_MATCHED });
      mockQueryDelay.mockResolvedValue({ statusCode: 200, body: DT_DELAYED_GR });
      mockGetEligibility.mockResolvedValue({ statusCode: 200, body: EE_ELIGIBLE_NULL_FARE });

      const app = await buildApp();
      const response = await request(app)
        .post('/api/journeys/check-delay')
        .send(ATTESTED_REQUEST_BODY)
        .expect(200);

      expect(response.body.eligible).toBe(true);
      expect(response.body.compensation_pence).toBe(14935);
    });
  });
});
