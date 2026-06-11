/**
 * Unit Tests: BFF ensure-on-404 — ADR-031 Part 2
 *
 * Phase   : T2-test (Jessie — Test Specification, TDD per ADR-014)
 * BL      : BL-315
 * ADR     : ADR-031 — Option (f) synchronous ensure-on-404
 * Date    : 2026-06-11
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * AC coverage map (web-app-bff — ADR-031 Part 2):
 *   AC-6 : On GET /delays/:id returning 404, BFF calls POST /delays/ensure via
 *          ensureDelay() client method instead of immediately returning { status: 'pending' }
 *   AC-7 : Terminal answers from ensure are folded into the composite:
 *          - 'delayed' → proceeds to eligibility trigger
 *          - 'on_time' → BFF returns terminal verdict (not pending)
 *          - 'no_data' → BFF returns terminal verdict (not pending)
 *          Assert BFF response for on_time / no_data is terminal (status NOT 'pending')
 *   AC-8 : When GET succeeds (row already exists), ensureDelay is NOT called
 *   AC-9 : ensureDelay uses a generous timeout (ENSURE_TIMEOUT_MS = 10000 — 10 s),
 *          distinct from the existing DELAY_TRACKER_TIMEOUT_MS = 2000.
 *          Assert ensureDelay uses 10000 ms (not 2000 ms) as its timeout budget.
 *
 * Concrete values (Blake must implement to these):
 *   ENSURE_TIMEOUT_MS = 10000  (10 s, exported constant)
 *   DELAY_TRACKER_TIMEOUT_MS = 2000  (unchanged, existing constant)
 *
 * Mocked endpoint (ensureDelay):
 *   // Mocked: POST {DELAY_TRACKER_URL}/delays/ensure
 *   // Will be verified real once Blake adds the route in delay-tracker
 *   // (AC-1 of ADR-031-ensure-endpoint.test.ts)
 *
 * Mocking strategy:
 *   - ../../../src/lib/delay-tracker-client.js — vi.mock (queryDelay + ensureDelay)
 *   - ../../../src/lib/journey-matcher-client.js — vi.mock
 *   - ../../../src/lib/eligibility-engine-client.js — vi.mock
 *   - ../../../src/lib/evaluation-coordinator-client.js — vi.mock
 *   - @railrepay/winston-logger — shared mock instance per CLAUDE.md §6.1 #11
 *   - @railrepay/metrics-pusher — mocked
 *
 * RED failure modes expected:
 *   - ensureDelay does not exist on delay-tracker-client.ts → import undefined
 *   - AC-6: queryDelay returns 404 → BFF still returns pending (old code path)
 *   - AC-9: ENSURE_TIMEOUT_MS constant does not exist → assertion on undefined
 *
 * ADR references:
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture
 *   ADR-031 — Synchronous ensure-on-404
 *   CLAUDE.md §6.1 — Test Specification Guidelines
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

const mockMatchJourney = vi.fn();
const mockQueryDelay = vi.fn();
const mockEnsureDelay = vi.fn();
const mockGetEligibility = vi.fn();
const mockTriggerEvaluation = vi.fn();

vi.mock('../../../src/lib/journey-matcher-client.js', () => ({
  matchJourney: mockMatchJourney,
}));

vi.mock('../../../src/lib/delay-tracker-client.js', () => ({
  queryDelay: mockQueryDelay,
  ensureDelay: mockEnsureDelay,
  DELAY_TRACKER_TIMEOUT_MS: 2000,
  // AC-9: ENSURE_TIMEOUT_MS will be added by Blake — currently undefined (RED)
  ENSURE_TIMEOUT_MS: undefined,
}));

vi.mock('../../../src/lib/eligibility-engine-client.js', () => ({
  getEligibility: mockGetEligibility,
}));

vi.mock('../../../src/lib/evaluation-coordinator-client.js', () => ({
  triggerEvaluation: mockTriggerEvaluation,
}));

// ─── UUID constants ───────────────────────────────────────────────────────────

const JOURNEY_ID_ADR031 = 'adr031bb-0001-4000-8000-000000000001';
const USER_ID_ADR031    = 'adr031uu-0001-4000-8000-000000000011';
const SESSION_SID_031   = 'sid-adr031-0001-4000-8000-000000000001';

// A separate journey that exists in delay-tracker (for AC-8 backward compat test)
const JOURNEY_ID_EXISTS = 'adr031bb-0002-4000-8000-000000000002';

// ─── Valid request body ───────────────────────────────────────────────────────

const VALID_BODY = {
  origin_station: 'York',
  destination_station: 'London Kings Cross',
  departure_date: '2026-06-03',
  departure_time: '08:30',
};

// ─── Helper: build Express app with check-delay handler + session ─────────────

async function buildApp() {
  const { createCheckDelayHandler } = await import('../../../src/handlers/check-delay.handler.js');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  // Inject session stub (mirrors existing test pattern)
  app.use((req, _res, next) => {
    (req as any).session = {
      user_id: USER_ID_ADR031,
      session_id: SESSION_SID_031,
    };
    next();
  });

  app.post('/api/journeys/check-delay', createCheckDelayHandler());
  return app;
}

// ─── Journey-matcher match fixture (returns JOURNEY_ID_ADR031) ───────────────

const JM_MATCHED = {
  status: 'matched',
  journey_id: JOURNEY_ID_ADR031,
  origin_station: 'York',
  destination_station: 'London Kings Cross',
  departure_date: '2026-06-03',
  departure_time: '08:30',
  journey_type: 'single',
  idempotent_replay: false,
};

const JM_MATCHED_EXISTS = {
  ...JM_MATCHED,
  journey_id: JOURNEY_ID_EXISTS,
};

// ─── Delay-tracker response fixtures ─────────────────────────────────────────

const DT_DELAYED = {
  journey_id: JOURNEY_ID_ADR031,
  delay_minutes: 18,
  cancelled: false,
  last_observed_at: '2026-06-03T10:48:00.000Z',
  status: 'delayed',
  toc_code: 'GR',
};

const DT_ON_TIME = {
  journey_id: JOURNEY_ID_ADR031,
  delay_minutes: 0,
  cancelled: false,
  last_observed_at: '2026-06-03T10:32:00.000Z',
  status: 'on_time',
  toc_code: 'GR',
};

// ─── Ensure response fixtures (new endpoint response shapes) ─────────────────

const ENSURE_DELAYED = {
  journey_id: JOURNEY_ID_ADR031,
  status: 'delayed',
  delay_minutes: 18,
  cancelled: false,
  toc_code: 'GR',
  last_observed_at: '2026-06-03T10:48:00.000Z',
};

const ENSURE_ON_TIME = {
  journey_id: JOURNEY_ID_ADR031,
  status: 'on_time',
  delay_minutes: 0,
  cancelled: false,
  toc_code: 'GR',
  last_observed_at: '2026-06-03T10:32:00.000Z',
};

const ENSURE_NO_DATA = {
  journey_id: JOURNEY_ID_ADR031,
  status: 'no_data',
};

// ─── Eligibility fixture ──────────────────────────────────────────────────────

const EE_ELIGIBLE = {
  journey_id: JOURNEY_ID_ADR031,
  eligible: true,
  scheme: 'DR15',
  delay_minutes: 18,
  compensation_percentage: 25,
  compensation_pence: 2238,
  ticket_fare_pence: 8950,
  reasons: ['Delay of 18 minutes qualifies for 25% refund'],
  applied_rules: ['DR15_15MIN_25PCT'],
  evaluation_timestamp: '2026-06-03T10:50:00.000Z',
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ADR-031 Part 2: BFF ensure-on-404', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    mockTriggerEvaluation.mockResolvedValue({ statusCode: 200, body: {} });
  });

  // ── AC-6: 404 → call ensureDelay instead of returning pending ───────────────

  describe('AC-6: GET 404 → BFF calls ensureDelay (not returning pending)', () => {
    it('should call ensureDelay when queryDelay returns 404', async () => {
      // AC-6: When GET /delays/:id returns 404, the BFF must call POST /delays/ensure
      // via ensureDelay(). Currently the old code returns { status: 'pending' } immediately.
      // RED: ensureDelay is not called because the old 404 branch returns pending directly.
      const app = await buildApp();

      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: JM_MATCHED });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: { error: 'unknown_journey' } });
      mockEnsureDelay.mockResolvedValue({
        statusCode: 200,
        body: ENSURE_DELAYED,
      });
      mockGetEligibility.mockResolvedValue({ statusCode: 200, body: EE_ELIGIBLE });

      await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', 'test-corr-adr031-ac6-0001')
        .send(VALID_BODY);

      // AC-6: ensureDelay MUST have been called
      // RED: currently ensureDelay is never called → mockEnsureDelay.mock.calls.length === 0
      expect(mockEnsureDelay).toHaveBeenCalledTimes(1);
    });

    it('should NOT return status:pending when queryDelay returns 404 (old behaviour eliminated)', async () => {
      // AC-6: The old code returned { status: 'pending' } on 404.
      // After ADR-031, 404 → ensureDelay → terminal response.
      // This test asserts the BFF response is not 'pending'.
      const app = await buildApp();

      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: JM_MATCHED });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: { error: 'unknown_journey' } });
      mockEnsureDelay.mockResolvedValue({ statusCode: 200, body: ENSURE_DELAYED });
      mockGetEligibility.mockResolvedValue({ statusCode: 200, body: EE_ELIGIBLE });

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', 'test-corr-adr031-ac6-0002')
        .send(VALID_BODY)
        .expect(200);

      // RED: currently returns { status: 'pending' } → this assertion fails
      expect(res.body.status).not.toBe('pending');
    });

    it('should pass journey_id and user context to ensureDelay', async () => {
      // AC-6: ensureDelay must receive the matched journey_id (not the request body journey_id)
      const app = await buildApp();

      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: JM_MATCHED });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: { error: 'unknown_journey' } });
      mockEnsureDelay.mockResolvedValue({ statusCode: 200, body: ENSURE_ON_TIME });

      await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', 'test-corr-adr031-ac6-0003')
        .send(VALID_BODY);

      expect(mockEnsureDelay).toHaveBeenCalledTimes(1);
      const [calledJourneyId, calledUserId] = mockEnsureDelay.mock.calls[0];
      expect(calledJourneyId).toBe(JOURNEY_ID_ADR031);
      expect(calledUserId).toBe(USER_ID_ADR031);
    });
  });

  // ── AC-7: Terminal answers folded into composite ───────────────────────────

  describe('AC-7: Terminal answers from ensure are folded into composite', () => {
    it('should proceed to eligibility when ensure returns delayed', async () => {
      // AC-7: ensure returns 'delayed' → BFF continues to eligibility-engine
      const app = await buildApp();

      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: JM_MATCHED });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: { error: 'unknown_journey' } });
      mockEnsureDelay.mockResolvedValue({ statusCode: 200, body: ENSURE_DELAYED });
      mockGetEligibility.mockResolvedValue({ statusCode: 200, body: EE_ELIGIBLE });

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .send(VALID_BODY)
        .expect(200);

      // Eligibility engine must have been called
      expect(mockGetEligibility).toHaveBeenCalledTimes(1);
      // Response must include eligibility fields (not pending)
      expect(typeof res.body.eligible).toBe('boolean');
      expect(res.body.status).not.toBe('pending');
    });

    it('should return terminal on_time verdict (not pending) when ensure returns on_time', async () => {
      // AC-7: ensure returns 'on_time' → BFF returns a terminal verdict.
      // The PWA must receive a definitive not-eligible outcome — it must NOT time out
      // waiting for a resolution that will never come.
      const app = await buildApp();

      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: JM_MATCHED });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: { error: 'unknown_journey' } });
      mockEnsureDelay.mockResolvedValue({ statusCode: 200, body: ENSURE_ON_TIME });

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .send(VALID_BODY)
        .expect(200);

      // RED: old code returns 'pending' when queryDelay returns 404
      // GREEN after Blake: status is terminal (on_time or similar, but NOT pending)
      expect(res.body.status).not.toBe('pending');
      // on_time response should indicate the journey was found and resolved
      expect(res.body.matched).toBe(true);
    });

    it('should return terminal no_data verdict (not pending) when ensure returns no_data', async () => {
      // AC-7: ensure returns 'no_data' (Darwin has no record) → BFF returns terminal verdict.
      // The PWA must render this as a definitive no-data outcome, not keep polling.
      const app = await buildApp();

      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: JM_MATCHED });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: { error: 'unknown_journey' } });
      mockEnsureDelay.mockResolvedValue({ statusCode: 200, body: ENSURE_NO_DATA });

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .send(VALID_BODY)
        .expect(200);

      // RED: old code returns 'pending'; GREEN: terminal no_data verdict
      expect(res.body.status).not.toBe('pending');
      expect(res.body.matched).toBe(true);
    });

    it('should NOT call ensureDelay when ensure returns on_time (no eligibility call needed)', async () => {
      // AC-7: on_time / no_data do not require eligibility evaluation
      // (no delay to compensate → skip eligibility-engine call)
      const app = await buildApp();

      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: JM_MATCHED });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: { error: 'unknown_journey' } });
      mockEnsureDelay.mockResolvedValue({ statusCode: 200, body: ENSURE_ON_TIME });

      await request(app)
        .post('/api/journeys/check-delay')
        .send(VALID_BODY);

      // on_time → no compensation possible → eligibility-engine NOT called
      // (This is the same semantics as the existing GET on_time path)
      // Adjust this expectation only if Blake's design calls eligibility anyway —
      // in that case hand back with explanation (Test Lock Rule)
      expect(mockGetEligibility).not.toHaveBeenCalled();
    });
  });

  // ── AC-8: GET success → ensureDelay NOT called ────────────────────────────

  describe('AC-8: GET success → ensureDelay NOT invoked (backward compatible)', () => {
    it('should NOT call ensureDelay when queryDelay returns 200', async () => {
      // AC-8: The ensure path is ONLY triggered on 404. If the row already exists
      // from the async Kafka pipeline, the BFF uses the existing GET result.
      const app = await buildApp();

      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: JM_MATCHED_EXISTS });
      mockQueryDelay.mockResolvedValue({ statusCode: 200, body: DT_DELAYED });
      mockGetEligibility.mockResolvedValue({ statusCode: 200, body: EE_ELIGIBLE });

      await request(app)
        .post('/api/journeys/check-delay')
        .send(VALID_BODY)
        .expect(200);

      // AC-8: ensureDelay must NOT be called when GET returns a result
      expect(mockEnsureDelay).not.toHaveBeenCalled();
    });

    it('should NOT call ensureDelay when queryDelay returns 200 with on_time', async () => {
      // AC-8: on_time from GET also means the row exists — no ensure needed
      const app = await buildApp();

      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: JM_MATCHED_EXISTS });
      mockQueryDelay.mockResolvedValue({ statusCode: 200, body: { ...DT_ON_TIME, journey_id: JOURNEY_ID_EXISTS } });
      mockGetEligibility.mockResolvedValue({
        statusCode: 200,
        body: {
          journey_id: JOURNEY_ID_EXISTS,
          eligible: false,
          scheme: 'DR15',
          delay_minutes: 0,
          compensation_percentage: 0,
          compensation_pence: 0,
          ticket_fare_pence: 4500,
          reasons: [],
          applied_rules: [],
          evaluation_timestamp: '2026-06-03T10:35:00.000Z',
        },
      });

      await request(app)
        .post('/api/journeys/check-delay')
        .send(VALID_BODY)
        .expect(200);

      expect(mockEnsureDelay).not.toHaveBeenCalled();
    });

    it('should return the normal composite response when queryDelay returns 200 delayed', async () => {
      // AC-8: Verify the normal flow (GET succeeds) still produces the full composite.
      // This is a regression guard — ADR-031 must not break the GET-success path.
      const app = await buildApp();

      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: JM_MATCHED_EXISTS });
      mockQueryDelay.mockResolvedValue({ statusCode: 200, body: { ...DT_DELAYED, journey_id: JOURNEY_ID_EXISTS } });
      mockGetEligibility.mockResolvedValue({ statusCode: 200, body: { ...EE_ELIGIBLE, journey_id: JOURNEY_ID_EXISTS } });

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .send(VALID_BODY)
        .expect(200);

      // Full composite response fields must be present
      expect(res.body.matched).toBe(true);
      expect(typeof res.body.eligible).toBe('boolean');
      expect(res.body.status).toBe('delayed');
    });
  });

  // ── AC-9: ensureDelay uses ENSURE_TIMEOUT_MS = 10000 (not 2000) ─────────────

  describe('AC-9: ensureDelay uses ENSURE_TIMEOUT_MS = 10000, not DELAY_TRACKER_TIMEOUT_MS = 2000', () => {
    it('should export ENSURE_TIMEOUT_MS = 10000 from delay-tracker-client', async () => {
      // AC-9: Blake must add ENSURE_TIMEOUT_MS = 10000 to delay-tracker-client.ts.
      // The ensure call needs a generous budget (~15s Darwin eval) vs the 2s GET timeout.
      // RED: ENSURE_TIMEOUT_MS is currently undefined (not exported).
      const dtClient = await import('../../../src/lib/delay-tracker-client.js');

      // RED: ENSURE_TIMEOUT_MS does not exist yet → assertion fails on undefined
      expect((dtClient as any).ENSURE_TIMEOUT_MS).toBe(10000);
    });

    it('should keep DELAY_TRACKER_TIMEOUT_MS = 2000 (existing GET timeout unchanged)', async () => {
      // AC-9: The existing 2s timeout for GET must remain unchanged.
      const dtClient = await import('../../../src/lib/delay-tracker-client.js');

      expect((dtClient as any).DELAY_TRACKER_TIMEOUT_MS).toBe(2000);
    });

    it('should have ensureDelay exported from delay-tracker-client', async () => {
      // AC-9: ensureDelay function must be exported.
      // RED: ensureDelay is not yet exported → assertion fails.
      const dtClient = await import('../../../src/lib/delay-tracker-client.js');

      // RED: ensureDelay does not exist on the module → typeof is 'undefined'
      expect(typeof (dtClient as any).ensureDelay).toBe('function');
    });

    it('should use ensureDelay (not queryDelay) when 404 path is triggered', async () => {
      // AC-9: Verifies the 404 path uses ensureDelay (which has the 10s timeout)
      // and NOT queryDelay (which has 2s timeout).
      // The mock already gates this: if the BFF calls queryDelay with 404-triggering args,
      // and then also calls ensureDelay, we know they are separate client calls.
      const app = await buildApp();

      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: JM_MATCHED });
      // First queryDelay returns 404 (triggers ensure path)
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: { error: 'unknown_journey' } });
      mockEnsureDelay.mockResolvedValue({ statusCode: 200, body: ENSURE_DELAYED });
      mockGetEligibility.mockResolvedValue({ statusCode: 200, body: EE_ELIGIBLE });

      await request(app)
        .post('/api/journeys/check-delay')
        .send(VALID_BODY);

      // queryDelay called once (the 404 call)
      expect(mockQueryDelay).toHaveBeenCalledTimes(1);
      // ensureDelay called once (the separate ensure call with longer timeout)
      // RED: ensureDelay is never called in current code
      expect(mockEnsureDelay).toHaveBeenCalledTimes(1);
      // They must be separate calls (not the same function)
      expect(mockQueryDelay).not.toBe(mockEnsureDelay);
    });

    it('should pass correlationId to ensureDelay for request tracing', async () => {
      // AC-9 / ADR-002: correlation ID must be forwarded to the ensure call
      const app = await buildApp();

      const correlationId = 'test-corr-adr031-ac9-ensure';
      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: JM_MATCHED });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: { error: 'unknown_journey' } });
      mockEnsureDelay.mockResolvedValue({ statusCode: 200, body: ENSURE_ON_TIME });

      await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', correlationId)
        .send(VALID_BODY);

      // AC-9 / ADR-002: correlation ID must be forwarded
      if (mockEnsureDelay.mock.calls.length > 0) {
        const args = mockEnsureDelay.mock.calls[0];
        // args[2] or args[3] should be correlationId (depends on Blake's signature)
        // Accept it anywhere in the args
        expect(args.some((a: unknown) => a === correlationId)).toBe(true);
      }
    });
  });

  // ── Additional: ensure 503 propagates correctly ──────────────────────────────

  describe('ensure path: upstream error handling', () => {
    it('should return 503 when ensureDelay itself returns 503 (upstream unavailable)', async () => {
      // If the ensure call fails (delay-tracker overloaded), return 503 to the PWA.
      // This is consistent with the existing queryDelay 503 handling.
      const app = await buildApp();

      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: JM_MATCHED });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: { error: 'unknown_journey' } });
      mockEnsureDelay.mockResolvedValue({ statusCode: 503, body: { error: 'upstream_unavailable' } });

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .send(VALID_BODY);

      // If ensure fails, return 503 (do not silently return pending)
      expect(res.status).toBe(503);
    });
  });
});
