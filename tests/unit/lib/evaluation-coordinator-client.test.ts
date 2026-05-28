/**
 * Unit Tests: evaluation-coordinator-client
 *
 * Bug Fix   : BL-308 — on-demand check-delay never triggers eligibility evaluation
 * Phase     : T2-test (Jessie — Test Specification, TDD per ADR-014)
 * Date      : 2026-05-28
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/lib/evaluation-coordinator-client.ts
 *
 * Failure reason: "Cannot find module '../../../src/lib/evaluation-coordinator-client.js'"
 *
 * AC coverage map (BL-308):
 *   AC-1 (DISPOSITIVE): triggerEvaluation() issues POST {EVALUATION_COORDINATOR_URL}/evaluate/:journeyId
 *   AC-3 (non-fatal 422): 422 dedup response resolves (no throw) — caller decides fate
 *   AC-2 (non-fatal 5xx): 5xx response throws (so handler's .catch path is exercised)
 *   AC-4 (missing env var): missing EVALUATION_COORDINATOR_URL → warns, no throw
 *   AC-5 (network error): network error → throws (handler's .catch absorbs it non-fatally)
 *   AC-5 (correlation ID): X-Correlation-ID forwarded on every outbound call (mirrors AC-13 on EE client)
 *
 * Mocked HTTP endpoint (tests):
 *   POST {EVALUATION_COORDINATOR_URL}/evaluate/:journeyId
 *   Verified real: services/evaluation-coordinator — Blake T1 confirmed 202/422 at that path
 *   ADR-028 (Option A): POST /evaluate/:journey_id, fire-and-forget, 202=accepted, 422=dedup
 *   Last verified: 2026-05-28 (Jessie BL-308 T2-test)
 *
 * Pattern mirrors: services/web-app-bff/tests/unit/lib/eligibility-engine-client.test.ts
 * (nock setup, httpPost via node http/https, AbortController, same logger mock pattern)
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-014 — TDD
 *   ADR-028 — On-demand evaluation trigger via evaluation-coordinator
 *   CLAUDE.md §6.1 #10 — Mocked Endpoint Verification
 *   CLAUDE.md §6.1 #11 — Infrastructure Package Mocking (shared logger instance)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import {
  MATCHED_JOURNEY_ID,
  SECOND_JOURNEY_ID,
  CORRELATION_ID_001,
  CORRELATION_ID_002,
} from '../../fixtures/check-delay-data.js';

// ─── Logger mock (CLAUDE.md §6.1 #11) ───────────────────────────────────────
// Shared instance OUTSIDE factory — same object referenced by all test assertions.
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
const { triggerEvaluation } = await import('../../../src/lib/evaluation-coordinator-client.js');

const EC_BASE = 'http://evaluation-coordinator-unit-test-bl308.internal';

describe('BL-308: evaluation-coordinator-client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nock.cleanAll();
    process.env.EVALUATION_COORDINATOR_URL = EC_BASE;
  });

  afterEach(() => {
    nock.cleanAll();
    delete process.env.EVALUATION_COORDINATOR_URL;
  });

  // ─── AC-1 (DISPOSITIVE): 202 accepted — fire-and-forget success ─────────────

  describe('AC-1 (DISPOSITIVE): triggerEvaluation issues POST /evaluate/:journeyId', () => {
    it('AC-1: should issue POST to /evaluate/:journeyId and resolve on 202', async () => {
      // AC-1: Coordinator accepts evaluation trigger
      // Mocked: POST {EVALUATION_COORDINATOR_URL}/evaluate/:journeyId
      // Verified real: services/evaluation-coordinator — ADR-028 Option A
      // Last verified: 2026-05-28 (Jessie BL-308 T2-test)
      nock(EC_BASE)
        .post(`/evaluate/${MATCHED_JOURNEY_ID}`)
        .reply(202, { status: 'accepted', journey_id: MATCHED_JOURNEY_ID });

      // Should resolve (not throw) on 202
      await expect(
        triggerEvaluation(MATCHED_JOURNEY_ID, CORRELATION_ID_001)
      ).resolves.not.toThrow();

      // nock assertion: exactly one POST was made to the correct path
      expect(nock.isDone()).toBe(true);
    });

    it('AC-1: issues POST to the correct path including the journeyId segment', async () => {
      // AC-1: Path must include the real journey_id (not null, not scan_id)
      let capturedPath = '';

      nock(EC_BASE)
        .post(/\/evaluate\//)
        .reply(function () {
          capturedPath = this.req.path;
          return [202, {}];
        });

      await triggerEvaluation(MATCHED_JOURNEY_ID, CORRELATION_ID_001);

      // AC-1: Path must end with the real journey_id
      expect(capturedPath).toBe(`/evaluate/${MATCHED_JOURNEY_ID}`);
    });

    it('AC-1: different journeyIds produce different POST paths (not hardcoded)', async () => {
      // AC-1: Second call with a different journey_id must use that id in the path
      const capturedPaths: string[] = [];

      nock(EC_BASE)
        .post(/\/evaluate\//)
        .twice()
        .reply(function () {
          capturedPaths.push(this.req.path);
          return [202, {}];
        });

      await triggerEvaluation(MATCHED_JOURNEY_ID, CORRELATION_ID_001);
      await triggerEvaluation(SECOND_JOURNEY_ID, CORRELATION_ID_002);

      expect(capturedPaths).toHaveLength(2);
      expect(capturedPaths[0]).toBe(`/evaluate/${MATCHED_JOURNEY_ID}`);
      expect(capturedPaths[1]).toBe(`/evaluate/${SECOND_JOURNEY_ID}`);
    });
  });

  // ─── AC-3: 422 dedup — non-fatal (resolves, does NOT throw) ─────────────────

  describe('AC-3: 422 duplicate workflow — non-fatal (resolves, no throw)', () => {
    it('AC-3: should resolve (not throw) when coordinator returns 422 dedup', async () => {
      // AC-3: 422 = evaluation already in flight — dedup, not an error
      // ADR-028: "422 (duplicate workflow) MUST be treated as non-fatal success/dedup"
      nock(EC_BASE)
        .post(`/evaluate/${MATCHED_JOURNEY_ID}`)
        .reply(422, { error: 'evaluation_already_in_progress', journey_id: MATCHED_JOURNEY_ID });

      // 422 MUST NOT throw — the handler's .catch MUST NOT be triggered for 422
      await expect(
        triggerEvaluation(MATCHED_JOURNEY_ID, CORRELATION_ID_001)
      ).resolves.not.toThrow();
    });
  });

  // ─── AC-2: 5xx error — throws (handler's .catch absorbs it) ─────────────────

  describe('AC-2: 5xx coordinator error — throws (handler catch path exercises non-fatal absorption)', () => {
    it('AC-2: should throw when coordinator returns 500', async () => {
      // AC-2: 5xx is unexpected — throw so the handler's .catch fires and absorbs it
      // Handler catch MUST return pending_eligibility 200, not propagate the error
      nock(EC_BASE)
        .post(`/evaluate/${MATCHED_JOURNEY_ID}`)
        .reply(500, { error: 'internal_server_error' });

      await expect(
        triggerEvaluation(MATCHED_JOURNEY_ID, CORRELATION_ID_001)
      ).rejects.toThrow();
    });

    it('AC-2: should throw when coordinator returns 503', async () => {
      nock(EC_BASE)
        .post(`/evaluate/${MATCHED_JOURNEY_ID}`)
        .reply(503, { error: 'service_unavailable' });

      await expect(
        triggerEvaluation(MATCHED_JOURNEY_ID, CORRELATION_ID_001)
      ).rejects.toThrow();
    });
  });

  // ─── AC-5: Network error — throws ────────────────────────────────────────────

  describe('AC-5: Network error — throws (handler catch path exercises non-fatal absorption)', () => {
    it('AC-5: should throw when connection is refused', async () => {
      // AC-5: Network error means coordinator unreachable — throw so handler catches
      nock(EC_BASE)
        .post(`/evaluate/${MATCHED_JOURNEY_ID}`)
        .replyWithError('ECONNREFUSED');

      await expect(
        triggerEvaluation(MATCHED_JOURNEY_ID, CORRELATION_ID_001)
      ).rejects.toThrow();
    });
  });

  // ─── AC-4: Missing EVALUATION_COORDINATOR_URL — warn, no throw ──────────────

  describe('AC-4: Missing EVALUATION_COORDINATOR_URL — graceful warn, no throw', () => {
    it('AC-4: should warn and resolve (not throw) when EVALUATION_COORDINATOR_URL is unset', async () => {
      // AC-4: Missing env var must NOT propagate into the handler
      // Blake's env-var testing pattern (CLAUDE.md §6.2): delete env var in test
      delete process.env.EVALUATION_COORDINATOR_URL;

      // Should resolve without throwing
      await expect(
        triggerEvaluation(MATCHED_JOURNEY_ID, CORRELATION_ID_001)
      ).resolves.not.toThrow();

      // Should have emitted a warning (not silent failure, not crash)
      expect(sharedLogger.warn).toHaveBeenCalled();

      // nock assertion: NO HTTP request made (env var missing = no URL to call)
      expect(nock.activeMocks()).toHaveLength(0);
    });
  });

  // ─── AC-5: X-Correlation-ID header forwarded ─────────────────────────────────

  describe('AC-5: X-Correlation-ID header forwarded on every outbound call', () => {
    it('AC-5: should forward X-Correlation-ID header on POST', async () => {
      let capturedCorrelationId: string | undefined;

      // Mocked: POST {EVALUATION_COORDINATOR_URL}/evaluate/:journeyId
      // Verified real: services/evaluation-coordinator — ADR-028 Option A
      // Last verified: 2026-05-28 (Jessie BL-308 T2-test)
      nock(EC_BASE)
        .post(`/evaluate/${MATCHED_JOURNEY_ID}`)
        .reply(function () {
          capturedCorrelationId = this.req.headers['x-correlation-id'] as string;
          return [202, {}];
        });

      await triggerEvaluation(MATCHED_JOURNEY_ID, CORRELATION_ID_001);

      // AC-5: X-Correlation-ID must have been forwarded
      expect(capturedCorrelationId).toBe(CORRELATION_ID_001);
    });

    it('AC-5: different correlation IDs are forwarded on different calls (not hardcoded)', async () => {
      const capturedIds: string[] = [];

      nock(EC_BASE)
        .post(/\/evaluate\//)
        .twice()
        .reply(function () {
          const id = this.req.headers['x-correlation-id'] as string;
          capturedIds.push(id);
          return [202, {}];
        });

      await triggerEvaluation(MATCHED_JOURNEY_ID, CORRELATION_ID_001);
      await triggerEvaluation(SECOND_JOURNEY_ID, CORRELATION_ID_002);

      expect(capturedIds).toHaveLength(2);
      expect(capturedIds[0]).toBe(CORRELATION_ID_001);
      expect(capturedIds[1]).toBe(CORRELATION_ID_002);
    });
  });
});
