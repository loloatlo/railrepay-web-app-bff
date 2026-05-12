/**
 * Unit Tests: eligibility-engine-client
 *
 * Story   : RAILREPAY-WEB-BFF-005
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-05-12
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/lib/eligibility-engine-client.ts
 *
 * Failure reason: "Cannot find module '../../src/lib/eligibility-engine-client.js'"
 *
 * AC coverage map:
 *   AC-11: 503/timeout from eligibility-engine → client returns { statusCode: 503, ... }
 *   AC-13: X-Correlation-ID header forwarded to eligibility-engine on every call
 *
 * Mocked HTTP endpoint:
 *   // Mocked: GET {ELIGIBILITY_ENGINE_URL}/eligibility/:journey_id
 *   // Verified real: services/eligibility-engine/src/app.ts
 *   //   app.get('/eligibility/:journey_id', async (req, res) => { ... })
 *   // Exposed at: services/eligibility-engine/src/index.ts via createApp()
 *   // Response shape (200): {
 *   //   journey_id, eligible, scheme, delay_minutes,
 *   //   compensation_percentage, compensation_pence, ticket_fare_pence,
 *   //   reasons, applied_rules, evaluation_timestamp
 *   // }
 *   // Response (404): { error: 'Evaluation not found', journey_id }
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
  SECOND_JOURNEY_ID,
  EE_ELIGIBLE_RESPONSE,
  EE_INELIGIBLE_RESPONSE,
  EE_NOT_FOUND_RESPONSE,
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
const { getEligibility } = await import('../../../src/lib/eligibility-engine-client.js');

const EE_BASE = 'http://eligibility-engine-unit-test-bff005.internal';

describe('RAILREPAY-WEB-BFF-005: eligibility-engine-client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nock.cleanAll();
    process.env.ELIGIBILITY_ENGINE_URL = EE_BASE;
  });

  afterEach(() => {
    nock.cleanAll();
    delete process.env.ELIGIBILITY_ENGINE_URL;
  });

  // ─── Happy path — eligible ───────────────────────────────────────────────

  describe('getEligibility — eligible response', () => {
    it('should return { statusCode: 200, body } with eligibility data on hit', async () => {
      // Mocked: GET {ELIGIBILITY_ENGINE_URL}/eligibility/:journey_id
      // Verified real: services/eligibility-engine/src/app.ts
      //   app.get('/eligibility/:journey_id', ...) — line 202
      // Exposed at: services/eligibility-engine/src/index.ts via createApp()
      // Last verified: 2026-05-12 (Jessie WEB-BFF-005 US-2)
      nock(EE_BASE)
        .get(`/eligibility/${MATCHED_JOURNEY_ID}`)
        .reply(200, EE_ELIGIBLE_RESPONSE);

      const result = await getEligibility(MATCHED_JOURNEY_ID, CORRELATION_ID_001);

      expect(result.statusCode).toBe(200);
      expect(result.body).toMatchObject({
        journey_id: MATCHED_JOURNEY_ID,
        eligible: true,
        scheme: 'DR15',
        compensation_pence: 2238,
        compensation_percentage: 25,
      });
    });

    it('should return { statusCode: 200, body } with ineligible data', async () => {
      // AC-4: on_time journey → below threshold → ineligible
      nock(EE_BASE)
        .get(`/eligibility/${SECOND_JOURNEY_ID}`)
        .reply(200, EE_INELIGIBLE_RESPONSE);

      const result = await getEligibility(SECOND_JOURNEY_ID, CORRELATION_ID_002);

      expect(result.statusCode).toBe(200);
      expect(result.body).toMatchObject({
        journey_id: SECOND_JOURNEY_ID,
        eligible: false,
        compensation_pence: 0,
      });
    });
  });

  // ─── 404 — eventual consistency race ────────────────────────────────────

  describe('getEligibility — 404 (evaluation not yet run)', () => {
    it('should return { statusCode: 404, body } when eligibility evaluation not found', async () => {
      // AC-8: eligibility-engine hasn't evaluated this journey yet (eventual consistency)
      // Verified response shape: { error: 'Evaluation not found', journey_id }
      // Source: services/eligibility-engine/src/app.ts line 233
      nock(EE_BASE)
        .get(`/eligibility/${MATCHED_JOURNEY_ID}`)
        .reply(404, EE_NOT_FOUND_RESPONSE);

      const result = await getEligibility(MATCHED_JOURNEY_ID, CORRELATION_ID_001);

      expect(result.statusCode).toBe(404);
      expect(result.body).toMatchObject({ error: 'Evaluation not found' });
    });
  });

  // ─── AC-13: Correlation ID propagation ──────────────────────────────────

  describe('AC-13: X-Correlation-ID header forwarded to eligibility-engine', () => {
    it('should forward X-Correlation-ID header on every outbound call', async () => {
      // AC-13: Verify X-Correlation-ID forwarded
      let capturedCorrelationId: string | undefined;

      // Mocked: GET {ELIGIBILITY_ENGINE_URL}/eligibility/:journey_id
      // Verified real: services/eligibility-engine/src/app.ts app.get('/eligibility/:journey_id')
      // Last verified: 2026-05-12 (Jessie WEB-BFF-005 US-2)
      nock(EE_BASE)
        .get(`/eligibility/${MATCHED_JOURNEY_ID}`)
        .reply(function () {
          capturedCorrelationId = this.req.headers['x-correlation-id'] as string;
          return [200, EE_ELIGIBLE_RESPONSE];
        });

      await getEligibility(MATCHED_JOURNEY_ID, CORRELATION_ID_001);

      // AC-13: X-Correlation-ID must have been forwarded
      expect(capturedCorrelationId).toBe(CORRELATION_ID_001);
    });

    it('should forward different correlation IDs on different calls (not hardcoded)', async () => {
      // AC-13: Multiple calls each get their own correlation ID
      const capturedIds: string[] = [];

      nock(EE_BASE)
        .get(`/eligibility/${MATCHED_JOURNEY_ID}`)
        .twice()
        .reply(function () {
          const id = this.req.headers['x-correlation-id'] as string;
          capturedIds.push(id);
          return [200, EE_ELIGIBLE_RESPONSE];
        });

      await getEligibility(MATCHED_JOURNEY_ID, CORRELATION_ID_001);
      await getEligibility(MATCHED_JOURNEY_ID, CORRELATION_ID_002);

      expect(capturedIds).toHaveLength(2);
      expect(capturedIds[0]).toBe(CORRELATION_ID_001);
      expect(capturedIds[1]).toBe(CORRELATION_ID_002);
    });
  });

  // ─── AC-11: Error handling / 503 ────────────────────────────────────────

  describe('AC-11: Error handling — 503 from eligibility-engine', () => {
    it('should return { statusCode: 503 } when eligibility-engine returns 503', async () => {
      nock(EE_BASE)
        .get(`/eligibility/${MATCHED_JOURNEY_ID}`)
        .reply(503, { error: 'Internal server error' });

      const result = await getEligibility(MATCHED_JOURNEY_ID, CORRELATION_ID_001);

      expect(result.statusCode).toBe(503);
    });

    it('should return { statusCode: 503 } when connection is refused (network error)', async () => {
      // AC-11: Network error — client must catch and return 503
      nock(EE_BASE)
        .get(`/eligibility/${MATCHED_JOURNEY_ID}`)
        .replyWithError('ECONNREFUSED');

      const result = await getEligibility(MATCHED_JOURNEY_ID, CORRELATION_ID_001);

      expect(result.statusCode).toBe(503);
    });
  });

  // ─── AC-11: AbortController timeout ─────────────────────────────────────

  describe('AC-11: AbortController timeout — 2s budget', () => {
    it('should return { statusCode: 503 } when request times out', async () => {
      // AC-11: Eligibility-engine timeout budget is 2s (per locked timeouts in handoff)
      nock(EE_BASE)
        .get(`/eligibility/${MATCHED_JOURNEY_ID}`)
        .delayConnection(10000) // 10s delay > 2s timeout
        .reply(200, EE_ELIGIBLE_RESPONSE);

      vi.useFakeTimers();
      const resultPromise = getEligibility(MATCHED_JOURNEY_ID, CORRELATION_ID_001);

      // Advance past the 2000ms timeout
      vi.advanceTimersByTime(2100);

      const result = await resultPromise;

      vi.useRealTimers();
      nock.cleanAll();

      expect(result.statusCode).toBe(503);
    });
  });

  // ─── Response shape completeness ─────────────────────────────────────────

  describe('getEligibility — full response body shape', () => {
    it('should return all eligibility fields from eligibility-engine verbatim', async () => {
      // Verify the client passes through the complete response body without stripping fields
      nock(EE_BASE)
        .get(`/eligibility/${MATCHED_JOURNEY_ID}`)
        .reply(200, EE_ELIGIBLE_RESPONSE);

      const result = await getEligibility(MATCHED_JOURNEY_ID, CORRELATION_ID_001);

      expect(result.statusCode).toBe(200);
      // All fields from eligibility-engine response shape must be present
      expect(result.body).toHaveProperty('journey_id');
      expect(result.body).toHaveProperty('eligible');
      expect(result.body).toHaveProperty('scheme');
      expect(result.body).toHaveProperty('delay_minutes');
      expect(result.body).toHaveProperty('compensation_percentage');
      expect(result.body).toHaveProperty('compensation_pence');
      expect(result.body).toHaveProperty('ticket_fare_pence');
      expect(result.body).toHaveProperty('reasons');
      expect(result.body).toHaveProperty('applied_rules');
      expect(result.body).toHaveProperty('evaluation_timestamp');
    });
  });
});
