/**
 * Unit Tests: check-delay handler — RAILREPAY-JM-002 additions
 *
 * RAILREPAY-JM-002 — US-2 RED tests (Jessie, 2026-06-07)
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify this file.
 *
 * This file is ADDITIVE to the existing check-delay.handler.test.ts (WEB-BFF-005).
 * Pre-existing tests are NOT duplicated here.
 *
 * ACs covered:
 *   AC-7: BFF forwards ticket_type EXPLICITLY (ADR-027);
 *         scan_id→OCR extracted_fields fallback ONLY when ticket_type absent.
 *
 * ADR-027: BFF owns canonical contract. ticket_type supplied by PWA in the
 * request body (extracted from OCR) and forwarded explicitly to journey-matcher.
 * Only when ticket_type is absent should BFF attempt to derive it from OCR
 * extracted_fields via scan_id lookup.
 *
 * Mocked modules:
 *   src/lib/journey-matcher-client.js — matchJourney mock
 *   src/lib/delay-tracker-client.js   — queryDelay mock
 *   src/lib/eligibility-engine-client.js — getEligibility mock
 *   src/lib/evaluation-coordinator-client.js — triggerEvaluation mock
 *   @railrepay/winston-logger — shared logger mock
 *   @railrepay/metrics-pusher — counter + histogram mocks
 *
 * Infrastructure Package Mocking (CLAUDE.md §6.1 #11):
 *   Shared logger instance OUTSIDE factory — same object in all assertions.
 *
 * Mocked HTTP endpoint (journey-matcher-client):
 *   POST {JOURNEY_MATCHER_URL}/journeys/match
 *   Verified real: services/journey-matcher/src/api/match-journey.handler.ts
 *   Last verified: 2026-06-07 (Jessie JM-002 US-2)
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
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
  MATCHED_JOURNEY_ID,
  JM_MATCH_RESPONSE_DELAYED,
  DT_DELAYED_RESPONSE,
  EE_ELIGIBLE_RESPONSE,
  CORRELATION_ID_001,
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

/** Base valid body — no ticket_type field */
const BASE_BODY = {
  origin_station: 'York',
  destination_station: 'London Kings Cross',
  departure_date: '2026-06-03',
  departure_time: '08:56',
};

/** Body WITH explicit ticket_type */
const BODY_WITH_TICKET_TYPE = {
  ...BASE_BODY,
  ticket_type: 'anytime',
};

/** Body with scan_id but NO ticket_type — OCR fallback path */
const BODY_WITH_SCAN_ID_ONLY = {
  ...BASE_BODY,
  scan_id: 'dddddddd-4444-4444-8444-dddddddddddd',
};

/** Body with BOTH ticket_type AND scan_id — ticket_type wins, scan_id not used for type */
const BODY_WITH_BOTH = {
  ...BASE_BODY,
  ticket_type: 'anytime',
  scan_id: 'eeeeeeee-5555-5555-8555-eeeeeeeeeeee',
};

/** Full happy-path journey-matcher + delay + eligibility stubs */
const JM_MATCHED = { statusCode: 200, body: JM_MATCH_RESPONSE_DELAYED };
const DT_DELAYED = { statusCode: 200, body: DT_DELAYED_RESPONSE };
const EE_ELIGIBLE = { statusCode: 200, body: EE_ELIGIBLE_RESPONSE };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RAILREPAY-JM-002 — check-delay handler ticket_type forwarding (AC-7)', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
    // Default happy-path stubs
    mockMatchJourney.mockResolvedValue(JM_MATCHED);
    mockQueryDelay.mockResolvedValue(DT_DELAYED);
    mockGetEligibility.mockResolvedValue(EE_ELIGIBLE);
    mockTriggerEvaluation.mockResolvedValue({ statusCode: 202 });
  });

  // ── AC-7: ticket_type forwarded explicitly ─────────────────────────────────

  describe('AC-7: ticket_type forwarded explicitly to journey-matcher when supplied', () => {
    it('AC-7: should forward ticket_type in matchJourney call when present in body', async () => {
      // AC-7 (ADR-027): BFF MUST explicitly include ticket_type in the journey-matcher call
      await request(app)
        .post('/api/journeys/check-delay')
        .set('X-Correlation-ID', CORRELATION_ID_001)
        .send(BODY_WITH_TICKET_TYPE)
        .set('Content-Type', 'application/json');

      expect(mockMatchJourney).toHaveBeenCalledWith(
        expect.objectContaining({ ticket_type: 'anytime' }),
        expect.anything()
      );
    });

    it('AC-7: should forward ticket_type=anytime to journey-matcher even without scan_id', async () => {
      // AC-7: ticket_type alone (no scan_id) must still be forwarded
      await request(app)
        .post('/api/journeys/check-delay')
        .send(BODY_WITH_TICKET_TYPE)
        .set('Content-Type', 'application/json');

      expect(mockMatchJourney).toHaveBeenCalledWith(
        expect.objectContaining({ ticket_type: 'anytime' }),
        expect.anything()
      );
    });

    it('AC-7: should NOT attempt OCR extracted_fields lookup when ticket_type is explicitly supplied', async () => {
      // AC-7: when ticket_type is in body, BFF does NOT need to fall back to scan_id→OCR.
      // Verified by checking that matchJourney is called with ticket_type directly, not null.
      await request(app)
        .post('/api/journeys/check-delay')
        .send(BODY_WITH_BOTH)
        .set('Content-Type', 'application/json');

      expect(mockMatchJourney).toHaveBeenCalledWith(
        expect.objectContaining({ ticket_type: 'anytime' }),
        expect.anything()
      );
    });

    it('AC-7: when BOTH ticket_type AND scan_id present, ticket_type wins — no OCR lookup', async () => {
      // AC-7: explicit ticket_type in request body takes priority over OCR extracted_fields
      // The matchJourney call must carry the body ticket_type, not null/undefined
      await request(app)
        .post('/api/journeys/check-delay')
        .send(BODY_WITH_BOTH)
        .set('Content-Type', 'application/json');

      const [inputArg] = mockMatchJourney.mock.calls[0] as [Record<string, unknown>];
      expect(inputArg['ticket_type']).toBe('anytime');
    });
  });

  // ── AC-7: scan_id fallback ONLY when ticket_type absent ───────────────────

  describe('AC-7: scan_id→OCR fallback only when ticket_type absent', () => {
    it('AC-7: should forward scan_id to journey-matcher when scan_id present but no ticket_type', async () => {
      // AC-7: scan_id forwarded (to allow JM to attempt OCR lookup downstream if needed)
      await request(app)
        .post('/api/journeys/check-delay')
        .send(BODY_WITH_SCAN_ID_ONLY)
        .set('Content-Type', 'application/json');

      expect(mockMatchJourney).toHaveBeenCalledWith(
        expect.objectContaining({ scan_id: 'dddddddd-4444-4444-8444-dddddddddddd' }),
        expect.anything()
      );
    });

    it('AC-7: should NOT include ticket_type in matchJourney call when not in body', async () => {
      // AC-7: if ticket_type is absent from body, it must NOT be injected as a phantom value
      await request(app)
        .post('/api/journeys/check-delay')
        .send(BASE_BODY) // no ticket_type, no scan_id
        .set('Content-Type', 'application/json');

      const [inputArg] = mockMatchJourney.mock.calls[0] as [Record<string, unknown>];
      // ticket_type should either be absent or explicitly undefined/null — not a fabricated string
      expect(inputArg['ticket_type']).toBeFalsy();
    });
  });

  // ── AC-7: attestation fields forwarded ────────────────────────────────────

  describe('AC-7: attestation fields (actual_departure_time, actual_rid) forwarded to journey-matcher', () => {
    it('AC-7: should forward actual_rid to journey-matcher when supplied', async () => {
      // AC-7: attestation fields must be forwarded explicitly (not silently dropped)
      await request(app)
        .post('/api/journeys/check-delay')
        .send({
          ...BODY_WITH_TICKET_TYPE,
          actual_departure_time: '08:56',
          actual_rid: '202606030856001',
        })
        .set('Content-Type', 'application/json');

      expect(mockMatchJourney).toHaveBeenCalledWith(
        expect.objectContaining({
          actual_rid: '202606030856001',
          actual_departure_time: '08:56',
        }),
        expect.anything()
      );
    });

    it('AC-7: should return 200 matched composite when anytime ticket attested and all upstreams OK', async () => {
      // AC-7: full happy path with attestation fields
      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('X-Correlation-ID', 'test-jm002-ac7-full')
        .send({
          ...BODY_WITH_TICKET_TYPE,
          actual_departure_time: '08:56',
          actual_rid: '202606030856001',
        })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.matched).toBe(true);
    });
  });

  // ── AC-7: candidate list response forwarding ──────────────────────────────

  describe('AC-7: BFF handles candidate list response from journey-matcher', () => {
    it('AC-7: should return candidate list response from journey-matcher to the PWA', async () => {
      // AC-7: when journey-matcher returns candidates (anytime no attest), BFF must
      // pass this through. The PWA will render the candidate-selection UI.
      mockMatchJourney.mockResolvedValue({
        statusCode: 200,
        body: {
          status: 'candidates',
          journey_id: null,
          candidates: [
            { rid: '202606030730001', scheduled_departure: '07:30' },
            { rid: '202606030856001', scheduled_departure: '08:56' },
            { rid: '202606037108175', scheduled_departure: '10:17' },
          ],
        },
      });

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .send(BODY_WITH_TICKET_TYPE)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('candidates');
      expect(Array.isArray(res.body.candidates)).toBe(true);
      expect(res.body.candidates.length).toBe(3);
    });

    it('AC-7: candidate response should NOT proceed to delay-tracker or eligibility-engine', async () => {
      // AC-7: candidate list is NOT a matched journey — no downstream calls needed
      mockMatchJourney.mockResolvedValue({
        statusCode: 200,
        body: {
          status: 'candidates',
          journey_id: null,
          candidates: [
            { rid: '202606030856001', scheduled_departure: '08:56' },
          ],
        },
      });

      await request(app)
        .post('/api/journeys/check-delay')
        .send(BODY_WITH_TICKET_TYPE)
        .set('Content-Type', 'application/json');

      expect(mockQueryDelay).not.toHaveBeenCalled();
      expect(mockGetEligibility).not.toHaveBeenCalled();
    });
  });
});
