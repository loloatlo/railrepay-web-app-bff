/**
 * BL-311: triggerEvaluation must POST body with delay_minutes + ticket_fare_pence (+ toc_code)
 *
 * Bug Fix  : BL-311 — triggerEvaluation() sends NO body in the POST request.
 *            The coordinator receives no delay_minutes/toc_code/ticket_fare_pence,
 *            so even after the evaluate() fix the payload is incomplete (defaults to
 *            UNKNOWN/0). Fix: BFF must extend the trigger body with these fields.
 * Phase    : T2-test (Jessie — Test Specification, TDD per ADR-014)
 * Date     : 2026-05-28
 * ADR-029  : Option A fix (human-approved)
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * THESE TESTS MUST FAIL ON CURRENT CODE (BFF HEAD 01a373e).
 * triggerEvaluation() currently issues POST with Content-Length: 0 and no body.
 * The nock interceptors below assert a JSON body is sent; they will NOT match
 * the current bodyless POST → nock will report an unmatched request / timeout.
 *
 * AC coverage map (BL-311 BFF client slice):
 *   AC-5 (DISPOSITIVE): triggerEvaluation() sends a JSON body containing
 *         delay_minutes + ticket_fare_pence (+ optional toc_code) to the coordinator.
 *   AC-5b: check-delay handler passes real delay_minutes (from delayBody) and
 *         ticket_fare_pence (from eligibility/request) into triggerEvaluation call.
 *
 * Mocked HTTP endpoint (tests):
 *   POST {EVALUATION_COORDINATOR_URL}/evaluate/:journeyId
 *   Verified real: services/evaluation-coordinator — ADR-029 Option A
 *   Blake T1 confirmed 202/422 at POST /evaluate/:journey_id
 *   // Verified: services/evaluation-coordinator/src/routes/evaluate.ts exposes POST /:journey_id
 *
 * Pattern mirrors: services/web-app-bff/tests/unit/lib/evaluation-coordinator-client.test.ts
 * (nock setup, httpPost via node http/https, shared logger mock per CLAUDE.md §6.1 #11)
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-014 — TDD
 *   ADR-029 — Coordinator must call evaluate() not checkEligibility() (Option A fix)
 *   CLAUDE.md §6.1 #10 — Mocked Endpoint Verification
 *   CLAUDE.md §6.1 #11 — Infrastructure Package Mocking (shared logger instance)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import {
  MATCHED_JOURNEY_ID,
  CORRELATION_ID_001,
  DT_DELAYED_RESPONSE,
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
const { triggerEvaluation } = await import('../../../src/lib/evaluation-coordinator-client.js');

const EC_BASE = 'http://evaluation-coordinator-bl311-test.internal';

// ─── Trigger payload (what BFF now must send per ADR-029 Option A) ────────────

/** Real delay_minutes from delay-tracker response (DT_DELAYED_RESPONSE.delay_minutes = 23) */
const DELAY_MINUTES = DT_DELAYED_RESPONSE.delay_minutes; // 23

/** Ticket fare in pence — sourced from the journey/scan context in the BFF request */
const TICKET_FARE_PENCE = 8950;

/** TOC code — sourced from delay-tracker response or journey-matcher response */
const TOC_CODE = 'GW';

// ─────────────────────────────────────────────────────────────────────────────

describe('BL-311: evaluation-coordinator-client — trigger body payload (AC-5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nock.cleanAll();
    process.env.EVALUATION_COORDINATOR_URL = EC_BASE;
  });

  afterEach(() => {
    nock.cleanAll();
    delete process.env.EVALUATION_COORDINATOR_URL;
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-5 (DISPOSITIVE): POST body must carry delay_minutes + ticket_fare_pence
  // WILL FAIL on current code: httpPost sends Content-Length: 0 with no body;
  // nock body-matching interceptor will NOT fire → nock.isDone() = false
  // or nock will report an error interceptor (unexpected request).
  // ──────────────────────────────────────────────────────────────────────────

  describe('AC-5 (DISPOSITIVE): triggerEvaluation POSTs body with delay_minutes + ticket_fare_pence', () => {
    it('AC-5: should POST a JSON body containing delay_minutes', async () => {
      // AC-5: The coordinator's evaluate() needs delay_minutes to call eligibility-engine.
      // Current code sends NO body (Content-Length: 0) → nock body match fails.
      //
      // DISPOSITIVE: This MUST FAIL on current code.
      // nock will not match the request (body is empty) → nock.isDone() = false → test fails.

      let capturedBody: Record<string, unknown> = {};

      nock(EC_BASE)
        .post(`/evaluate/${MATCHED_JOURNEY_ID}`)
        .reply(function (_path, body) {
          capturedBody = typeof body === 'string' ? JSON.parse(body) : (body as Record<string, unknown>);
          return [202, { status: 'accepted' }];
        });

      await triggerEvaluation(MATCHED_JOURNEY_ID, CORRELATION_ID_001, {
        delay_minutes: DELAY_MINUTES,
        ticket_fare_pence: TICKET_FARE_PENCE,
        toc_code: TOC_CODE,
      });

      // AC-5: Body must have been sent and must contain delay_minutes
      expect(nock.isDone()).toBe(true);
      expect(capturedBody).toMatchObject({ delay_minutes: DELAY_MINUTES });
    });

    it('AC-5: POST body contains ticket_fare_pence', async () => {
      // AC-5: ticket_fare_pence is needed by evaluate() to compute compensation_pence.

      let capturedBody: Record<string, unknown> = {};

      nock(EC_BASE)
        .post(`/evaluate/${MATCHED_JOURNEY_ID}`)
        .reply(function (_path, body) {
          capturedBody = typeof body === 'string' ? JSON.parse(body) : (body as Record<string, unknown>);
          return [202, {}];
        });

      await triggerEvaluation(MATCHED_JOURNEY_ID, CORRELATION_ID_001, {
        delay_minutes: DELAY_MINUTES,
        ticket_fare_pence: TICKET_FARE_PENCE,
        toc_code: TOC_CODE,
      });

      expect(capturedBody).toMatchObject({ ticket_fare_pence: TICKET_FARE_PENCE });
    });

    it('AC-5: POST body contains toc_code when provided', async () => {
      // AC-5: toc_code enables the eligibility engine to look up scheme-specific rules.

      let capturedBody: Record<string, unknown> = {};

      nock(EC_BASE)
        .post(`/evaluate/${MATCHED_JOURNEY_ID}`)
        .reply(function (_path, body) {
          capturedBody = typeof body === 'string' ? JSON.parse(body) : (body as Record<string, unknown>);
          return [202, {}];
        });

      await triggerEvaluation(MATCHED_JOURNEY_ID, CORRELATION_ID_001, {
        delay_minutes: DELAY_MINUTES,
        ticket_fare_pence: TICKET_FARE_PENCE,
        toc_code: TOC_CODE,
      });

      expect(capturedBody).toMatchObject({ toc_code: TOC_CODE });
    });

    it('AC-5: all three fields present in a single POST call', async () => {
      // AC-5: Comprehensive — all three trigger fields together.

      let capturedBody: Record<string, unknown> = {};

      nock(EC_BASE)
        .post(`/evaluate/${MATCHED_JOURNEY_ID}`)
        .reply(function (_path, body) {
          capturedBody = typeof body === 'string' ? JSON.parse(body) : (body as Record<string, unknown>);
          return [202, {}];
        });

      await triggerEvaluation(MATCHED_JOURNEY_ID, CORRELATION_ID_001, {
        delay_minutes: 118,
        ticket_fare_pence: 12500,
        toc_code: 'EM',
      });

      expect(capturedBody).toMatchObject({
        delay_minutes: 118,
        ticket_fare_pence: 12500,
        toc_code: 'EM',
      });
    });

    it('AC-5: different journey_ids produce POST bodies with the correct fields (not hardcoded)', async () => {
      // AC-5: Verify the payload is dynamic (not a constant body).

      const capturedBodies: Record<string, unknown>[] = [];
      const capturedPaths: string[] = [];

      nock(EC_BASE)
        .post(/\/evaluate\//)
        .twice()
        .reply(function (_path, body) {
          capturedPaths.push(this.req.path);
          capturedBodies.push(typeof body === 'string' ? JSON.parse(body) : (body as Record<string, unknown>));
          return [202, {}];
        });

      await triggerEvaluation(MATCHED_JOURNEY_ID, CORRELATION_ID_001, {
        delay_minutes: 23,
        ticket_fare_pence: 8950,
        toc_code: 'GW',
      });

      await triggerEvaluation('dddddddd-4444-4444-8444-dddddddddddd', CORRELATION_ID_001, {
        delay_minutes: 60,
        ticket_fare_pence: 5500,
        toc_code: 'TL',
      });

      expect(capturedBodies).toHaveLength(2);
      expect(capturedBodies[0]).toMatchObject({ delay_minutes: 23, toc_code: 'GW' });
      expect(capturedBodies[1]).toMatchObject({ delay_minutes: 60, toc_code: 'TL' });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-5: existing BL-308 behaviours preserved with body (regression guards)
  // These test that 202, 422, 5xx still work correctly when body is present.
  // ──────────────────────────────────────────────────────────────────────────

  describe('AC-5: BL-308 non-fatal behaviours preserved when body is added', () => {
    it('AC-5: resolves on 202 with trigger body present', async () => {
      nock(EC_BASE)
        .post(`/evaluate/${MATCHED_JOURNEY_ID}`)
        .reply(202, {});

      await expect(
        triggerEvaluation(MATCHED_JOURNEY_ID, CORRELATION_ID_001, {
          delay_minutes: DELAY_MINUTES,
          ticket_fare_pence: TICKET_FARE_PENCE,
          toc_code: TOC_CODE,
        })
      ).resolves.not.toThrow();
    });

    it('AC-5: resolves (non-fatal) on 422 dedup with trigger body present', async () => {
      nock(EC_BASE)
        .post(`/evaluate/${MATCHED_JOURNEY_ID}`)
        .reply(422, { error: 'evaluation_already_in_progress' });

      await expect(
        triggerEvaluation(MATCHED_JOURNEY_ID, CORRELATION_ID_001, {
          delay_minutes: DELAY_MINUTES,
          ticket_fare_pence: TICKET_FARE_PENCE,
          toc_code: TOC_CODE,
        })
      ).resolves.not.toThrow();
    });

    it('AC-5: throws on 5xx with trigger body present', async () => {
      nock(EC_BASE)
        .post(`/evaluate/${MATCHED_JOURNEY_ID}`)
        .reply(500, { error: 'internal' });

      await expect(
        triggerEvaluation(MATCHED_JOURNEY_ID, CORRELATION_ID_001, {
          delay_minutes: DELAY_MINUTES,
          ticket_fare_pence: TICKET_FARE_PENCE,
          toc_code: TOC_CODE,
        })
      ).rejects.toThrow();
    });
  });
});
