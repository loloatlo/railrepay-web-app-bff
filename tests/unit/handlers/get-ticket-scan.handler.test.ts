/**
 * Unit Tests: GET /api/tickets/:scanId handler
 *
 * Story   : RAILREPAY-WEB-BFF-004
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-27
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/handlers/get-ticket-scan.handler.ts
 *   src/routes/tickets.ts (mounting GET /api/tickets/:scanId)
 *   src/lib/ocr-service-client.ts
 *   src/lib/scan-ownership-store.ts
 *
 * Failure reason: "Cannot find module" or route 404.
 *
 * AC coverage map:
 *   AC-8:  GET /api/tickets/:scanId — 401 when no session (cookie + Bearer absent)
 *   AC-9:  scanId must match UUID-v4 regex; malformed → 400 { error: 'invalid scan_id format' }
 *   AC-10: On valid scanId + ocr 200 → 200 with verbatim ocr result fields
 *          (scan_id, status, confidence, extracted_fields, raw_text, claim_ready,
 *           ocr_status, gcs_upload_status, image_gcs_path, error_message, created_at, updated_at)
 *   AC-11: User scoping — BFF checks bff:scan:<scanId> in Redis;
 *          absent OR value !== req.session.user_id → 403 { error: 'forbidden' }
 *   AC-12: OCR 404 → 404 { error: 'scan not found' }
 *   AC-13: OCR 5xx → 503 { error: 'ocr_unavailable' }
 *          Unexpected OCR 4xx → 502 { error: 'ocr_error', upstream_status: <n> }
 *
 * Mocked HTTP (nock):
 *   // Mocked: GET {OCR_SERVICE_URL}/ocr/results/:scanId
 *   // Verified real: services/ocr/src/handlers/results.handler.ts createResultsHandler
 *   // Exposed at: services/ocr/src/index.ts mounted at /ocr/results/:scanId
 *   // Last verified: 2026-04-27 (Jessie WEB-BFF-004 US-2)
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §6.1 #10 — Mocked Endpoint Verification
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  HAPPY_SCAN_ID,
  SECOND_SCAN_ID,
  MALFORMED_SCAN_ID,
  NUMERIC_SCAN_ID,
  OCR_RESULTS_RESPONSE,
  PRIMARY_USER,
  SECOND_USER,
} from '../../fixtures/scan-data.js';

// ─── OCR stub base URL ─────────────────────────────────────────────────────────
const OCR_BASE = 'http://ocr-stub.test';

// ─── Shared logger mock (Guideline #11 in jessie-qa-tdd-enforcer.md) ──────────
const sharedLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

// ─── ioredis mock ─────────────────────────────────────────────────────────────
const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  expire: vi.fn(),
  del: vi.fn(),
  ping: vi.fn().mockResolvedValue('PONG'),
  on: vi.fn().mockReturnThis(),
};

vi.mock('ioredis', () => ({
  default: vi.fn(() => mockRedis),
  Redis: vi.fn(() => mockRedis),
}));

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-004: GET /api/tickets/:scanId handler unit tests', () => {
  let app: ReturnType<typeof express>;

  beforeEach(async () => {
    vi.clearAllMocks();
    nock.cleanAll();

    process.env.OCR_SERVICE_URL = OCR_BASE;
    process.env.SESSION_COOKIE_NAME = 'rr_session';
    process.env.JWT_SECRET = 'test-secret-32-chars-minimum-aaa';
    process.env.JWT_ISSUER = 'auth-service';
    process.env.JWT_AUDIENCE = 'web-app-bff';
    process.env.NODE_ENV = 'test';

    // @ts-expect-error — module does not exist yet (TDD RED phase)
    const { createTicketsRouter } = await import('../../../src/routes/tickets.js');
    // @ts-expect-error — module does not exist yet (TDD RED phase)
    const { createCookieSessionMiddleware } = await import('../../../src/middleware/cookie-session.js');
    // @ts-expect-error — module does not exist yet (TDD RED phase)
    const { createBearerFallbackMiddleware } = await import('../../../src/middleware/bearer-fallback.js');

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(createCookieSessionMiddleware(mockRedis));
    app.use(createBearerFallbackMiddleware());
    app.use(createTicketsRouter(mockRedis));
  });

  afterEach(() => {
    nock.cleanAll();
    vi.restoreAllMocks();
    delete process.env.OCR_SERVICE_URL;
    delete process.env.SESSION_COOKIE_NAME;
    delete process.env.JWT_SECRET;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    delete process.env.NODE_ENV;
  });

  // Helper: stub mockRedis to return session for primary user, then ownership key
  function setupPrimaryUserSession(): void {
    mockRedis.get.mockImplementation((key: string) => {
      if (key === `bff:session:${PRIMARY_USER.session_id}`) {
        return Promise.resolve(JSON.stringify({
          user_id: PRIMARY_USER.user_id,
          session_id: PRIMARY_USER.session_id,
          access_token: PRIMARY_USER.access_token,
          refresh_at_iso: PRIMARY_USER.refresh_at_iso,
          created_at_iso: PRIMARY_USER.created_at_iso,
        }));
      }
      if (key === `bff:scan:${HAPPY_SCAN_ID}`) {
        return Promise.resolve(PRIMARY_USER.user_id);
      }
      return Promise.resolve(null);
    });
    mockRedis.expire.mockResolvedValue(1);
  }

  // ─── AC-8: Auth required ────────────────────────────────────────────────

  describe('AC-8: GET /api/tickets/:scanId — requires authenticated session', () => {
    it('AC-8: should return 401 when no cookie and no Bearer', async () => {
      mockRedis.get.mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/tickets/${HAPPY_SCAN_ID}`);

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: 'unauthorized' });
    });
  });

  // ─── AC-9: scanId format validation ─────────────────────────────────────

  describe('AC-9: scanId must match UUID-v4 regex — malformed → 400', () => {
    it('AC-9: should return 400 { error: invalid scan_id format } for malformed scanId', async () => {
      setupPrimaryUserSession();

      const res = await request(app)
        .get(`/api/tickets/${MALFORMED_SCAN_ID}`)
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid scan_id format' });
    });

    it('AC-9: should return 400 for all-numeric scanId (not UUID format)', async () => {
      setupPrimaryUserSession();

      const res = await request(app)
        .get(`/api/tickets/${NUMERIC_SCAN_ID}`)
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid scan_id format' });
    });

    it('AC-9: should NOT return 400 for a valid UUID-v4 scanId', async () => {
      setupPrimaryUserSession();

      // Mocked: GET {OCR_SERVICE_URL}/ocr/results/:scanId
      // Verified real: services/ocr/src/handlers/results.handler.ts createResultsHandler
      // Exposed at: services/ocr/src/index.ts mounted at /ocr/results/:scanId
      // Last verified: 2026-04-27 (Jessie WEB-BFF-004 US-2)
      nock(OCR_BASE)
        .get(`/ocr/results/${HAPPY_SCAN_ID}`)
        .reply(200, OCR_RESULTS_RESPONSE);

      const res = await request(app)
        .get(`/api/tickets/${HAPPY_SCAN_ID}`)
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`);

      expect(res.status).not.toBe(400);
    });
  });

  // ─── AC-10: 200 with verbatim ocr result fields ──────────────────────────

  describe('AC-10: valid scanId + ocr 200 → 200 with verbatim ocr result fields', () => {
    it('AC-10: should return 200 with all ocr result fields verbatim', async () => {
      setupPrimaryUserSession();

      nock(OCR_BASE)
        .get(`/ocr/results/${HAPPY_SCAN_ID}`)
        .reply(200, OCR_RESULTS_RESPONSE);

      const res = await request(app)
        .get(`/api/tickets/${HAPPY_SCAN_ID}`)
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`);

      expect(res.status).toBe(200);
      // AC-10: verbatim ocr result field presence check
      expect(res.body).toHaveProperty('scan_id');
      expect(res.body).toHaveProperty('status');
      expect(res.body).toHaveProperty('confidence');
      expect(res.body).toHaveProperty('extracted_fields');
      expect(res.body).toHaveProperty('raw_text');
      expect(res.body).toHaveProperty('claim_ready');
      expect(res.body).toHaveProperty('ocr_status');
      expect(res.body).toHaveProperty('gcs_upload_status');
      expect(res.body).toHaveProperty('image_gcs_path');
      expect(res.body).toHaveProperty('error_message');
      expect(res.body).toHaveProperty('created_at');
      expect(res.body).toHaveProperty('updated_at');
    });

    it('AC-10: returned body values must match ocr service response (verbatim passthrough)', async () => {
      setupPrimaryUserSession();

      nock(OCR_BASE)
        .get(`/ocr/results/${HAPPY_SCAN_ID}`)
        .reply(200, OCR_RESULTS_RESPONSE);

      const res = await request(app)
        .get(`/api/tickets/${HAPPY_SCAN_ID}`)
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`);

      expect(res.status).toBe(200);
      expect(res.body.scan_id).toBe(OCR_RESULTS_RESPONSE.scan_id);
      expect(res.body.status).toBe(OCR_RESULTS_RESPONSE.status);
      expect(res.body.confidence).toBe(OCR_RESULTS_RESPONSE.confidence);
      expect(res.body.claim_ready).toBe(OCR_RESULTS_RESPONSE.claim_ready);
      expect(res.body.ocr_status).toBe(OCR_RESULTS_RESPONSE.ocr_status);
      expect(res.body.gcs_upload_status).toBe(OCR_RESULTS_RESPONSE.gcs_upload_status);
    });
  });

  // ─── AC-11: User scoping — bff:scan:<scanId> Redis ownership check ───────

  describe('AC-11: user scoping — bff:scan:<scanId> absent or mismatched → 403', () => {
    it('AC-11: should return 403 { error: forbidden } when bff:scan:<scanId> key absent in Redis', async () => {
      // Session is valid, but the ownership key does not exist
      mockRedis.get.mockImplementation((key: string) => {
        if (key === `bff:session:${PRIMARY_USER.session_id}`) {
          return Promise.resolve(JSON.stringify({
            user_id: PRIMARY_USER.user_id,
            session_id: PRIMARY_USER.session_id,
            access_token: PRIMARY_USER.access_token,
            refresh_at_iso: PRIMARY_USER.refresh_at_iso,
            created_at_iso: PRIMARY_USER.created_at_iso,
          }));
        }
        // Ownership key absent
        return Promise.resolve(null);
      });
      mockRedis.expire.mockResolvedValue(1);

      const res = await request(app)
        .get(`/api/tickets/${HAPPY_SCAN_ID}`)
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`);

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'forbidden' });
    });

    it('AC-11: should return 403 when bff:scan:<scanId> user_id does not match session user_id (second user)', async () => {
      // Session belongs to PRIMARY_USER, but scan was uploaded by SECOND_USER
      mockRedis.get.mockImplementation((key: string) => {
        if (key === `bff:session:${PRIMARY_USER.session_id}`) {
          return Promise.resolve(JSON.stringify({
            user_id: PRIMARY_USER.user_id,
            session_id: PRIMARY_USER.session_id,
            access_token: PRIMARY_USER.access_token,
            refresh_at_iso: PRIMARY_USER.refresh_at_iso,
            created_at_iso: PRIMARY_USER.created_at_iso,
          }));
        }
        if (key === `bff:scan:${SECOND_SCAN_ID}`) {
          // Scan belongs to SECOND_USER, not PRIMARY_USER
          return Promise.resolve(SECOND_USER.user_id);
        }
        return Promise.resolve(null);
      });
      mockRedis.expire.mockResolvedValue(1);

      const res = await request(app)
        .get(`/api/tickets/${SECOND_SCAN_ID}`)
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`);

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'forbidden' });
    });

    it('AC-11: should return 200 when bff:scan:<scanId> matches session user_id (correct owner)', async () => {
      setupPrimaryUserSession(); // PRIMARY_USER owns HAPPY_SCAN_ID

      nock(OCR_BASE)
        .get(`/ocr/results/${HAPPY_SCAN_ID}`)
        .reply(200, OCR_RESULTS_RESPONSE);

      const res = await request(app)
        .get(`/api/tickets/${HAPPY_SCAN_ID}`)
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`);

      expect(res.status).toBe(200);
    });
  });

  // ─── AC-12: OCR 404 → 404 ───────────────────────────────────────────────

  describe('AC-12: ocr returns 404 → 404 { error: scan not found }', () => {
    it('AC-12: should return 404 { error: scan not found } when ocr returns 404', async () => {
      setupPrimaryUserSession();

      nock(OCR_BASE)
        .get(`/ocr/results/${HAPPY_SCAN_ID}`)
        .reply(404, { error: `Scan not found: ${HAPPY_SCAN_ID}` });

      const res = await request(app)
        .get(`/api/tickets/${HAPPY_SCAN_ID}`)
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`);

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: 'scan not found' });
    });
  });

  // ─── AC-13: OCR error mapping ────────────────────────────────────────────

  describe('AC-13: OCR error mapping — 503 on 5xx, 502 on unexpected 4xx', () => {
    it('AC-13: should return 503 { error: ocr_unavailable } when ocr returns 503', async () => {
      setupPrimaryUserSession();

      nock(OCR_BASE)
        .get(`/ocr/results/${HAPPY_SCAN_ID}`)
        .reply(503, { error: 'service_unavailable' });

      const res = await request(app)
        .get(`/api/tickets/${HAPPY_SCAN_ID}`)
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`);

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ error: 'ocr_unavailable' });
    });

    it('AC-13: should return 503 when ocr returns 500 (internal server error)', async () => {
      setupPrimaryUserSession();

      nock(OCR_BASE)
        .get(`/ocr/results/${HAPPY_SCAN_ID}`)
        .reply(500, { error: 'internal_server_error' });

      const res = await request(app)
        .get(`/api/tickets/${HAPPY_SCAN_ID}`)
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`);

      expect(res.status).toBe(503);
    });

    it('AC-13: should return 502 { error: ocr_error, upstream_status } on unexpected 4xx from ocr', async () => {
      setupPrimaryUserSession();

      nock(OCR_BASE)
        .get(`/ocr/results/${HAPPY_SCAN_ID}`)
        .reply(400, { error: 'bad_request' });

      const res = await request(app)
        .get(`/api/tickets/${HAPPY_SCAN_ID}`)
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`);

      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({
        error: 'ocr_error',
        upstream_status: 400,
      });
    });
  });
});
