/**
 * Unit Tests: journey-matcher-client — RAILREPAY-JM-002 additions
 *
 * RAILREPAY-JM-002 — US-2 RED tests (Jessie, 2026-06-07)
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify this file.
 *
 * This file is ADDITIVE to the existing journey-matcher-client.test.ts (WEB-BFF-005).
 * Pre-existing tests are NOT duplicated here.
 *
 * ACs covered:
 *   AC-7: MatchJourneyInput type carries ticket_type, actual_departure_time,
 *         actual_rid — new optional fields forwarded in HTTP POST body.
 *         (Verified: POST {JOURNEY_MATCHER_URL}/journeys/match)
 *
 * Mocked HTTP endpoint:
 *   POST {JOURNEY_MATCHER_URL}/journeys/match
 *   Verified real: services/journey-matcher/src/api/match-journey.handler.ts
 *   Exposed at: services/journey-matcher/src/index.ts app.use('/journeys', ...)
 *   New fields accepted after JM-002: ticket_type, actual_departure_time, actual_rid
 *   Last verified: 2026-06-07 (Jessie JM-002 US-2)
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-014 — TDD
 *   ADR-027 — BFF owns canonical client-facing contract
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import {
  VALID_CHECK_DELAY_BODY,
  JM_MATCH_RESPONSE_DELAYED,
  CHECK_DELAY_USER,
  CORRELATION_ID_001,
} from '../../fixtures/check-delay-data.js';

// ─── Logger mock (CLAUDE.md §6.1 #11) ────────────────────────────────────────
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
const { matchJourney } = await import('../../../src/lib/journey-matcher-client.js');

const JM_BASE = 'http://jm-jm002-unit-test.internal';

describe('RAILREPAY-JM-002: journey-matcher-client — new fields (AC-7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nock.cleanAll();
    process.env.JOURNEY_MATCHER_URL = JM_BASE;
  });

  afterEach(() => {
    nock.cleanAll();
    delete process.env.JOURNEY_MATCHER_URL;
  });

  // ── AC-7: new optional fields included in POST body ──────────────────────

  describe('AC-7: ticket_type forwarded in POST body to journey-matcher', () => {
    it('AC-7: should include ticket_type in the HTTP request body when supplied', async () => {
      // AC-7: the client must serialize ticket_type into the POST body
      let capturedBody: Record<string, unknown> = {};

      nock(JM_BASE)
        .post('/journeys/match', (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, JM_MATCH_RESPONSE_DELAYED);

      await matchJourney(
        {
          user_id: CHECK_DELAY_USER.user_id,
          ...VALID_CHECK_DELAY_BODY,
          ticket_type: 'anytime',
        },
        CORRELATION_ID_001
      );

      expect(capturedBody['ticket_type']).toBe('anytime');
    });

    it('AC-7: should include actual_departure_time in the HTTP request body when supplied', async () => {
      // AC-7: attestation field forwarded
      let capturedBody: Record<string, unknown> = {};

      nock(JM_BASE)
        .post('/journeys/match', (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, JM_MATCH_RESPONSE_DELAYED);

      await matchJourney(
        {
          user_id: CHECK_DELAY_USER.user_id,
          ...VALID_CHECK_DELAY_BODY,
          ticket_type: 'anytime',
          actual_departure_time: '08:56',
        },
        CORRELATION_ID_001
      );

      expect(capturedBody['actual_departure_time']).toBe('08:56');
    });

    it('AC-7: should include actual_rid in the HTTP request body when supplied', async () => {
      // AC-7: attestation RID forwarded
      let capturedBody: Record<string, unknown> = {};

      nock(JM_BASE)
        .post('/journeys/match', (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, JM_MATCH_RESPONSE_DELAYED);

      await matchJourney(
        {
          user_id: CHECK_DELAY_USER.user_id,
          ...VALID_CHECK_DELAY_BODY,
          ticket_type: 'anytime',
          actual_departure_time: '08:56',
          actual_rid: '202606030856001',
        },
        CORRELATION_ID_001
      );

      expect(capturedBody['actual_rid']).toBe('202606030856001');
    });

    it('AC-7: should NOT include ticket_type in the request body when not supplied', async () => {
      // AC-7: omitting ticket_type must not fabricate a value
      let capturedBody: Record<string, unknown> = {};

      nock(JM_BASE)
        .post('/journeys/match', (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, JM_MATCH_RESPONSE_DELAYED);

      await matchJourney(
        {
          user_id: CHECK_DELAY_USER.user_id,
          ...VALID_CHECK_DELAY_BODY,
          // No ticket_type
        },
        CORRELATION_ID_001
      );

      expect(capturedBody['ticket_type']).toBeFalsy();
    });

    it('AC-7: should handle candidate-list response from journey-matcher without error', async () => {
      // AC-7: the client must pass through the candidates shape returned by journey-matcher
      nock(JM_BASE)
        .post('/journeys/match')
        .reply(200, {
          status: 'candidates',
          journey_id: null,
          candidates: [
            { rid: '202606030856001', scheduled_departure: '08:56' },
          ],
        });

      const result = await matchJourney(
        {
          user_id: CHECK_DELAY_USER.user_id,
          ...VALID_CHECK_DELAY_BODY,
          ticket_type: 'anytime',
        },
        CORRELATION_ID_001
      );

      expect(result.statusCode).toBe(200);
      const body = result.body as Record<string, unknown>;
      expect(body['status']).toBe('candidates');
    });
  });
});
