/**
 * BL-359 AC-3: web-app-bff — reconciliation guard for ensure vs eligibility delay_minutes
 *
 * Phase   : T2-test (Jessie — Test Specification, TDD per ADR-014)
 * BL      : BL-359
 * Date    : 2026-06-20
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * ─── THE BUG ──────────────────────────────────────────────────────────────────
 * check-delay.handler.ts ensure composite path (~L529, L587-599):
 *
 * When ensure returns { status:'delayed', delay_minutes:27 } and the subsequent
 * eligibility GET returns { eligible:false, reasons:[{...delay_minutes:0...}] },
 * the BFF assembles the composite as:
 *   { delay_minutes: 27,   ← from ensure (correct)
 *     reasons: [{ delay_minutes: 0, ... }]  ← from stale eligibility row (wrong) }
 *
 * This is the "27-vs-0" display bug: the headline says 27 minutes, but the
 * reason card says "your train was delayed 0 minutes, which doesn't qualify."
 *
 * ─── WHAT BLAKE MUST DO ───────────────────────────────────────────────────────
 * In the ensure composite path (lines ~579-603 of check-delay.handler.ts), after
 * receiving the eligibility GET response, add a reconciliation guard:
 *
 * If ensureResult.delay_minutes !== eligibility.reasons[N].delay_minutes for any
 * reason in the reasons array (i.e., the stale row disagrees with the ensure
 * headline), the BFF must NOT staple the stale reasons onto the response. Instead:
 *   Option A: re-trigger eligibility evaluation (triggerEvaluation) and return
 *     pending_eligibility rather than the full composite.
 *   Option B: return a consistent composite where reasons are stripped/replaced
 *     with the ensure delay_minutes so the UI shows a coherent result.
 *
 * Either option is acceptable as long as the test assertions pass. The key
 * invariant: the BFF MUST NOT return delay_minutes:27 + reasons carrying 0.
 *
 * For the GET /delays path (when delay-tracker returns 200 directly, not via ensure),
 * the same reconciliation guard applies to lines ~707-726.
 *
 * ─── AC COVERAGE MAP ──────────────────────────────────────────────────────────
 * AC-3 (primary): ensure composite where ensure delay_minutes=27 but eligibility
 *   reasons carry delay_minutes=0 → BFF DOES NOT return the 27-vs-0 payload.
 *   Asserts the invariant: if eligible.reasons exists, reasons delay MUST match
 *   headline delay_minutes.
 *
 * AC-4 (consistency invariant): same as AC-3 but asserted differently — verify
 *   no response payload contains mismatched delay_minutes at top-level vs reasons.
 *
 * AC-5 (no-regression a): happy path — ensure delay_minutes=27, eligibility
 *   reasons carry delay_minutes=27 → BFF returns consistent composite unchanged.
 *
 * AC-5 (no-regression b): on-time path — ensure delay_minutes=0, no reasons
 *   → BFF returns on_time terminal unchanged.
 *
 * AC-5 (no-regression c): DR30 not-eligible path — ensure delay_minutes=27,
 *   eligibility eligible=false, reasons carry 27 → BFF returns correct
 *   not-eligible response (27 < 30-min threshold = not eligible).
 *
 * ─── MOCKING PATTERN ─────────────────────────────────────────────────────────
 * Mirrors ADR-031-ensure-on-404.handler.test.ts:
 *   - @railrepay/winston-logger — shared logger mock (CLAUDE.md §6.1 #11)
 *   - @railrepay/metrics-pusher — mocked
 *   - All client functions: vi.fn() OUTSIDE the factory + vi.mock factory
 *   - Mock-queue gotcha: beforeEach uses vi.clearAllMocks() on module-level mocks
 *
 * Mocked endpoints:
 *   - POST {JOURNEY_MATCHER_URL}/journeys/match     (matchJourney)
 *   - GET  {DELAY_TRACKER_URL}/delays/:id           (queryDelay → 404 triggers ensure)
 *   - POST {DELAY_TRACKER_URL}/delays/ensure        (ensureDelay)
 *   - GET  {ELIGIBILITY_ENGINE_URL}/eligibility/:id (getEligibility)
 *   - POST {EVALUATION_COORDINATOR_URL}/...         (triggerEvaluation — called non-fatally)
 *
 * ADR references:
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture
 *   ADR-031 — Synchronous ensure-on-404
 *   CLAUDE.md §6.1 #11 — Infrastructure package mocking
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
  ENSURE_TIMEOUT_MS: 10000,
}));

vi.mock('../../../src/lib/eligibility-engine-client.js', () => ({
  getEligibility: mockGetEligibility,
}));

vi.mock('../../../src/lib/evaluation-coordinator-client.js', () => ({
  triggerEvaluation: mockTriggerEvaluation,
}));

// ─── UUID constants — unique per scenario (Guideline #6) ─────────────────────

// AC-3 / AC-4 (stale mismatch): ensure says 27, eligibility reasons say 0
const JOURNEY_ID_STALE_MISMATCH = 'bl359bb-0001-4000-8000-000000000001';
const USER_ID_BL359 = 'bl359uu-0001-4000-8000-000000000011';
const SESSION_SID_BL359 = 'sid-bl359-0001-4000-8000-000000000001';

// AC-5a (happy path: consistent 27+27): ensure says 27, eligibility reasons say 27
const JOURNEY_ID_CONSISTENT = 'bl359bb-0002-4000-8000-000000000002';

// AC-5b (on-time, no reasons): ensure says 0, no eligibility reasons
const JOURNEY_ID_ONTIME = 'bl359bb-0003-4000-8000-000000000003';

// AC-5c (DR30 not-eligible: 27 < 30 threshold): ensure 27, eligibility not-eligible, reasons 27
const JOURNEY_ID_DR30 = 'bl359bb-0004-4000-8000-000000000004';

// ─── Valid request body ───────────────────────────────────────────────────────

const VALID_BODY = {
  origin_station: 'Leeds',
  destination_station: 'Newquay',
  departure_date: '2026-06-20',
  departure_time: '07:30',
};

// ─── Journey-matcher fixture ──────────────────────────────────────────────────

function jmMatched(journeyId: string) {
  return {
    status: 'matched',
    journey_id: journeyId,
    origin_station: 'Leeds',
    destination_station: 'Newquay',
    departure_date: '2026-06-20',
    departure_time: '07:30',
    journey_type: 'single',
    idempotent_replay: false,
  };
}

// ─── Delay-tracker ensure fixtures ───────────────────────────────────────────

// Ensure returns 27-min delay (from the real multi-leg SLW path)
function ensureDelayed(journeyId: string) {
  return {
    status: 'delayed',
    journey_id: journeyId,
    delay_minutes: 27,
    cancelled: false,
    toc_code: 'GW',
    last_observed_at: '2026-06-20T15:00:00.000Z',
  };
}

// Ensure returns 0-min on_time
function ensureOnTime(journeyId: string) {
  return {
    status: 'on_time',
    journey_id: journeyId,
    delay_minutes: 0,
    cancelled: false,
    toc_code: 'GW',
    last_observed_at: '2026-06-20T14:31:00.000Z',
  };
}

// ─── Eligibility engine fixtures ──────────────────────────────────────────────

// STALE eligibility: returns not-eligible with reasons that say 0 minutes
// This is the exact bug: ensure said 27, but the elig row was evaluated at 0
function eeStaleZeroMinutes(journeyId: string) {
  return {
    journey_id: journeyId,
    eligible: false,
    scheme: 'DR30',
    delay_minutes: 0,        // ← stale: was evaluated before real delay arrived
    compensation_percentage: 0,
    compensation_pence: 0,
    ticket_fare_pence: 14935,
    reasons: [
      // The reasons carry the stale 0-minute delay — that's the display bug
      'Delay of 0 minutes does not meet the 30 minute DR30 threshold',
    ],
    applied_rules: [],
    evaluation_timestamp: '2026-06-20T12:00:00.000Z',  // earlier than the real delay
  };
}

// CONSISTENT eligibility: returns not-eligible with reasons matching 27 minutes (DR30)
function eeConsistentDR30NotEligible(journeyId: string) {
  return {
    journey_id: journeyId,
    eligible: false,
    scheme: 'DR30',
    delay_minutes: 27,        // matches ensure headline
    compensation_percentage: 0,
    compensation_pence: 0,
    ticket_fare_pence: 14935,
    reasons: [
      'Delay of 27 minutes does not meet the 30 minute DR30 threshold',
    ],
    applied_rules: [],
    evaluation_timestamp: '2026-06-20T15:05:00.000Z',
  };
}

// CONSISTENT eligibility: returns eligible with reasons matching 27 minutes (DR15)
function eeConsistentEligible(journeyId: string) {
  return {
    journey_id: journeyId,
    eligible: true,
    scheme: 'DR15',
    delay_minutes: 27,
    compensation_percentage: 25,
    compensation_pence: 3733,  // 25% of 14935
    ticket_fare_pence: 14935,
    reasons: [
      'Delay of 27 minutes qualifies for 25% refund under DR15',
    ],
    applied_rules: ['DR15_15MIN_25PCT'],
    evaluation_timestamp: '2026-06-20T15:05:00.000Z',
  };
}

// ─── Helper: build Express app ────────────────────────────────────────────────

async function buildApp(userId: string = USER_ID_BL359) {
  const { createCheckDelayHandler } = await import('../../../src/handlers/check-delay.handler.js');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  app.use((req, _res, next) => {
    (req as Record<string, unknown> & typeof req).session = {
      user_id: userId,
      session_id: SESSION_SID_BL359,
    };
    next();
  });

  app.post('/api/journeys/check-delay', createCheckDelayHandler());
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('BL-359 AC-3: BFF reconciliation guard — ensure delay vs eligibility reasons', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    // Use mockResolvedValue for triggerEvaluation (non-fatal fire-and-forget)
    mockTriggerEvaluation.mockResolvedValue({ statusCode: 202, body: {} });
  });

  // ── AC-3 (primary defect): stale reasons mismatch must be caught ─────────

  describe('AC-3: ensure delay_minutes=27 + eligibility reasons carrying delay_minutes=0 → BFF MUST NOT return the 27-vs-0 payload', () => {

    it('should NOT return a composite where top-level delay_minutes=27 but reasons describe 0 minutes', async () => {
      // THE BUG: the BFF at ~L587-599 staples the eligibility reasons (carrying 0)
      // directly onto the composite with the ensure delay_minutes (27).
      // Result: { delay_minutes: 27, reasons: ['0 minutes does not qualify'] }
      //
      // RED REASON: the current handler has no reconciliation guard — it passes
      // through the stale eligibility reasons unconditionally.
      // After Blake's fix: the BFF detects the mismatch and either returns
      // pending_eligibility (to trigger a fresh evaluation) or strips the stale reasons.

      const app = await buildApp();

      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: jmMatched(JOURNEY_ID_STALE_MISMATCH) });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: { error: 'unknown_journey' } });
      mockEnsureDelay.mockResolvedValue({ statusCode: 200, body: ensureDelayed(JOURNEY_ID_STALE_MISMATCH) });
      // Stale eligibility row: reasons carry delay_minutes=0 (the bug)
      mockGetEligibility.mockResolvedValue({ statusCode: 200, body: eeStaleZeroMinutes(JOURNEY_ID_STALE_MISMATCH) });

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', 'bl359-ac3-stale-mismatch-0001')
        .send(VALID_BODY)
        .expect(200);

      const body = res.body as Record<string, unknown>;

      // The invariant: EITHER
      //   a) the response is pending_eligibility (reconciliation chose to re-trigger), OR
      //   b) the response has reasons whose text does NOT describe 0 minutes alongside a 27-min headline
      // In either case, the 27-vs-0 stale composite MUST NOT be returned.
      //
      // RED: currently the BFF returns { delay_minutes: 27, reasons: ['0 minutes...'] }
      // GREEN after fix: the response is either pending_eligibility OR a consistent composite.

      const reasonsArr = body['reasons'];
      const topLevelDelay = body['delay_minutes'];

      if (Array.isArray(reasonsArr) && reasonsArr.length > 0 && topLevelDelay === 27) {
        // If we have a composite with delay_minutes=27 AND reasons array,
        // the reasons must NOT contain "0 minutes" language
        const reasonsText = reasonsArr.join(' ').toLowerCase();
        expect(reasonsText).not.toMatch(/\b0 minutes\b/);
        expect(reasonsText).not.toMatch(/delay of 0 minutes/i);
      }
    });

    it('should NOT return eligible=false with reasons describing 0 minutes when ensure says 27', async () => {
      // A stricter form: the reasons text must not contradict the headline delay.
      // If eligible=false is returned with a 27-min headline, the reason must say 27, not 0.
      //
      // RED REASON: the stale reasons array from the eligibility engine literally says
      // "0 minutes does not meet the threshold" while delay_minutes=27. This is the
      // exact text the user sees in the not-eligible result card.

      const app = await buildApp();

      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: jmMatched(JOURNEY_ID_STALE_MISMATCH) });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: { error: 'unknown_journey' } });
      mockEnsureDelay.mockResolvedValue({ statusCode: 200, body: ensureDelayed(JOURNEY_ID_STALE_MISMATCH) });
      mockGetEligibility.mockResolvedValue({ statusCode: 200, body: eeStaleZeroMinutes(JOURNEY_ID_STALE_MISMATCH) });

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', 'bl359-ac3-stale-mismatch-0002')
        .send(VALID_BODY)
        .expect(200);

      const body = res.body as Record<string, unknown>;

      // If the response includes delay_minutes=27 AND reasons array AND eligible=false,
      // the reasons text must not mention "0 minutes" (that would be the stale text)
      if (
        body['delay_minutes'] === 27 &&
        body['eligible'] === false &&
        Array.isArray(body['reasons'])
      ) {
        const reasonsText = (body['reasons'] as string[]).join(' ').toLowerCase();
        // Must NOT say 0 minutes in the reason when the headline says 27
        expect(reasonsText).not.toMatch(/\b0\s*minutes\b/);
        expect(reasonsText).not.toMatch(/delay of 0/i);
      }
    });

    it('should return pending_eligibility OR a consistent composite when stale reasons mismatch (not the broken 27-vs-0)', async () => {
      // This is the DISPOSITIVE test. One of two outcomes is valid after Blake's fix:
      //
      // Option A: BFF detects mismatch → returns pending_eligibility → re-triggers eval
      //   { matched:true, delay_minutes:27, status:'pending_eligibility' }
      //   (The UI polls and renders the fresh 27-vs-DR30-not-eligible correctly.)
      //
      // Option B: BFF strips the stale reasons and returns a consistent composite
      //   where the reasons (if present) describe 27 minutes.
      //
      // RED REASON: currently BFF returns the third option (broken) — the 27-vs-0
      // composite — which is explicitly prohibited by this test.

      const app = await buildApp();

      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: jmMatched(JOURNEY_ID_STALE_MISMATCH) });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: { error: 'unknown_journey' } });
      mockEnsureDelay.mockResolvedValue({ statusCode: 200, body: ensureDelayed(JOURNEY_ID_STALE_MISMATCH) });
      mockGetEligibility.mockResolvedValue({ statusCode: 200, body: eeStaleZeroMinutes(JOURNEY_ID_STALE_MISMATCH) });

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', 'bl359-ac3-stale-mismatch-0003')
        .send(VALID_BODY)
        .expect(200);

      const body = res.body as Record<string, unknown>;

      // The response must be ONE OF:
      //   - pending_eligibility (Option A) — BFF detected mismatch + re-triggered
      //   - A composite where reasons describe 27 minutes (Option B)
      //
      // It must NOT be the broken composite where delay_minutes=27 AND reasons say 0.

      const isOptionA = body['status'] === 'pending_eligibility';
      const reasonsArr = Array.isArray(body['reasons']) ? (body['reasons'] as string[]) : [];
      const isBroken27vs0 =
        body['delay_minutes'] === 27 &&
        reasonsArr.length > 0 &&
        reasonsArr.join(' ').toLowerCase().match(/\b0\s*minutes\b/) !== null;

      // Must be Option A or Option B (not the broken 27-vs-0)
      // If neither option A nor avoiding the broken combo, the test fails
      if (!isOptionA) {
        // If NOT pending_eligibility, then reasons must not describe 0 minutes
        expect(isBroken27vs0).toBe(false);
      }
      // If IS pending_eligibility, that's a valid resolution
      if (isOptionA) {
        expect(body['matched']).toBe(true);
        expect(body['delay_minutes']).toBe(27);
      }
    });
  });

  // ── AC-4 (consistency invariant): delay_minutes at top level must match reasons ─

  describe('AC-4: consistency invariant — top-level delay_minutes must match reasons (no cross-field mismatch)', () => {

    it('should not produce a composite where delay_minutes at top-level disagrees with delay in reasons text', async () => {
      // AC-4 invariant: if the BFF returns a composite with both delay_minutes AND reasons,
      // the reasons text must not describe a DIFFERENT delay than the top-level figure.
      //
      // This test applies to ALL composite responses — not just the stale case.
      // It is the most general form of the reconciliation invariant.

      const app = await buildApp();

      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: jmMatched(JOURNEY_ID_STALE_MISMATCH) });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: { error: 'unknown_journey' } });
      mockEnsureDelay.mockResolvedValue({ statusCode: 200, body: ensureDelayed(JOURNEY_ID_STALE_MISMATCH) });
      // Stale eligibility row
      mockGetEligibility.mockResolvedValue({ statusCode: 200, body: eeStaleZeroMinutes(JOURNEY_ID_STALE_MISMATCH) });

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', 'bl359-ac4-invariant-0001')
        .send(VALID_BODY)
        .expect(200);

      const body = res.body as Record<string, unknown>;
      const topDelay = body['delay_minutes'] as number | undefined;
      const reasonsArr = body['reasons'] as string[] | undefined;

      // If both are present, they must not contradict each other
      if (topDelay !== undefined && Array.isArray(reasonsArr) && reasonsArr.length > 0) {
        const reasonsText = reasonsArr.join(' ').toLowerCase();
        // If top-level delay is 27, reasons must not describe 0 minutes
        if (topDelay === 27) {
          expect(reasonsText).not.toMatch(/delay of 0 minutes/i);
          expect(reasonsText).not.toMatch(/\b0 minutes\b/);
        }
        // If top-level delay is 0, reasons must not describe 27 minutes
        if (topDelay === 0) {
          expect(reasonsText).not.toMatch(/delay of 27 minutes/i);
        }
      }
    });
  });

  // ── AC-5a no-regression: consistent 27+27 composite unchanged ────────────────

  describe('AC-5a no-regression: consistent ensure=27 + eligibility reasons=27 → composite returned unchanged', () => {

    it('should return the full composite when ensure and eligibility delays are consistent (both 27)', async () => {
      // Happy path: ensure says 27, eligibility also records 27 and says not-eligible (DR30).
      // The BFF must return this composite as-is — no disruption from the reconciliation guard.

      const app = await buildApp();

      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: jmMatched(JOURNEY_ID_CONSISTENT) });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: { error: 'unknown_journey' } });
      mockEnsureDelay.mockResolvedValue({ statusCode: 200, body: ensureDelayed(JOURNEY_ID_CONSISTENT) });
      // Consistent eligibility: delay_minutes=27 in both the row and reasons
      mockGetEligibility.mockResolvedValue({ statusCode: 200, body: eeConsistentDR30NotEligible(JOURNEY_ID_CONSISTENT) });

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', 'bl359-ac5a-consistent-0001')
        .send(VALID_BODY)
        .expect(200);

      const body = res.body as Record<string, unknown>;

      // Response must be the full composite (not pending_eligibility)
      expect(body['matched']).toBe(true);
      expect(body['delay_minutes']).toBe(27);
      expect(body['eligible']).toBe(false);

      // Status must not be pending_eligibility — this is a consistent resolved result
      expect(body['status']).not.toBe('pending_eligibility');
    });

    it('should return the full composite when ensure=27 + eligibility eligible=true with reasons=27', async () => {
      // Eligible happy path: 27 min delay, DR15, eligible=true.
      // The reconciliation guard must not interfere with consistent eligible results.

      const app = await buildApp();

      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: jmMatched(JOURNEY_ID_CONSISTENT) });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: { error: 'unknown_journey' } });
      mockEnsureDelay.mockResolvedValue({ statusCode: 200, body: ensureDelayed(JOURNEY_ID_CONSISTENT) });
      mockGetEligibility.mockResolvedValue({ statusCode: 200, body: eeConsistentEligible(JOURNEY_ID_CONSISTENT) });

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', 'bl359-ac5a-eligible-0002')
        .send(VALID_BODY)
        .expect(200);

      const body = res.body as Record<string, unknown>;

      expect(body['matched']).toBe(true);
      expect(body['delay_minutes']).toBe(27);
      expect(body['eligible']).toBe(true);
      expect(body['status']).not.toBe('pending_eligibility');
    });
  });

  // ── AC-5b no-regression: on-time path (ensure delay_minutes=0) ──────────────

  describe('AC-5b no-regression: ensure returns on_time (delay_minutes=0) → BFF returns terminal on_time unchanged', () => {

    it('should return matched:true + status:on_time when ensure returns on_time (no eligibility call)', async () => {
      // On-time path via the ensure route: the BFF must not call eligibility-engine
      // and must return a terminal on_time verdict. No reconciliation needed here.

      const app = await buildApp();

      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: jmMatched(JOURNEY_ID_ONTIME) });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: { error: 'unknown_journey' } });
      mockEnsureDelay.mockResolvedValue({ statusCode: 200, body: ensureOnTime(JOURNEY_ID_ONTIME) });

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', 'bl359-ac5b-ontime-0001')
        .send(VALID_BODY)
        .expect(200);

      const body = res.body as Record<string, unknown>;

      expect(body['matched']).toBe(true);
      expect(body['status']).toBe('on_time');
      // getEligibility must NOT have been called for on_time (no delay to compensate)
      expect(mockGetEligibility).not.toHaveBeenCalled();
    });
  });

  // ── AC-5c no-regression: DR30 not-eligible correct path (27 < 30 threshold) ──

  describe('AC-5c no-regression: ensure=27, eligibility=not-eligible (DR30 threshold=30) → returns consistent not-eligible', () => {

    it('should return not-eligible composite when ensure=27 and eligibility says not-eligible (DR30, 27<30)', async () => {
      // The legitimate not-eligible case for LDS→NQY: 27 minutes, DR30 threshold is 30.
      // The eligibility row correctly says not-eligible with reasons describing 27 minutes.
      // The BFF must return this composite correctly (no guard misfire).

      const app = await buildApp();

      mockMatchJourney.mockResolvedValue({ statusCode: 200, body: jmMatched(JOURNEY_ID_DR30) });
      mockQueryDelay.mockResolvedValue({ statusCode: 404, body: { error: 'unknown_journey' } });
      mockEnsureDelay.mockResolvedValue({ statusCode: 200, body: ensureDelayed(JOURNEY_ID_DR30) });
      // Correct eligibility: not-eligible but with consistent delay_minutes=27 in reasons
      mockGetEligibility.mockResolvedValue({ statusCode: 200, body: eeConsistentDR30NotEligible(JOURNEY_ID_DR30) });

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', 'bl359-ac5c-dr30-0001')
        .send(VALID_BODY)
        .expect(200);

      const body = res.body as Record<string, unknown>;

      // The correct not-eligible composite:
      expect(body['matched']).toBe(true);
      expect(body['delay_minutes']).toBe(27);
      expect(body['eligible']).toBe(false);
      // Not pending_eligibility — this is a resolved, consistent verdict
      expect(body['status']).not.toBe('pending_eligibility');

      // The reasons must describe 27 minutes (not 0)
      if (Array.isArray(body['reasons'])) {
        const reasonsText = (body['reasons'] as string[]).join(' ');
        // If reasons mention delay minutes at all, they must say 27, not 0
        if (/\d+ minutes/i.test(reasonsText)) {
          expect(reasonsText).not.toMatch(/\b0 minutes\b/);
        }
      }
    });
  });
});
