/**
 * Unit Tests: POST /api/tickets/upload handler
 *
 * Story   : RAILREPAY-WEB-BFF-004
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-27
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/handlers/upload-ticket.handler.ts
 *   src/routes/tickets.ts (mounting POST /api/tickets/upload)
 *   src/lib/ocr-service-client.ts
 *   src/lib/scan-ownership-store.ts
 *
 * Failure reason: "Cannot find module" or route 404.
 *
 * AC coverage map:
 *   AC-1: POST /api/tickets/upload — 401 when no session (cookie + Bearer absent)
 *   AC-2: Accepts multipart/form-data with `image` field — 200 { scan_id }
 *   AC-3: Missing `image` field → 400 { error: 'image field is required' }
 *   AC-4: Image >10MB → 413 { error: 'image too large', max_bytes: 10485760 }
 *         (pre-stream rejection — busboy limits.fileSize triggers before full body loaded)
 *   AC-5: Unsupported MIME type → 415 { error: 'unsupported content_type',
 *         supported: ['image/jpeg','image/png'] }
 *   AC-6: Forwards image to ocr via POST {OCR_SERVICE_URL}/ocr/scan with
 *         { image_base64, content_type, user_id, correlation_id, source? }
 *   AC-7: Optional multipart text field `source` forwarded to ocr;
 *         when omitted, source NOT sent as 'unknown' (field simply absent)
 *
 * Mocked HTTP (nock):
 *   // Mocked: POST {OCR_SERVICE_URL}/ocr/scan
 *   // Verified real: services/ocr/src/handlers/scan.handler.ts createScanHandler
 *   // Exposed at: services/ocr/src/index.ts mounted at /ocr/scan
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
  MINIMAL_JPEG_BUFFER,
  MINIMAL_PNG_BUFFER,
  OVERSIZED_BUFFER,
  OCR_SCAN_RESPONSE,
  FULL_OCR_UPLOAD_RESPONSE,
  HAPPY_SCAN_ID,
  PRIMARY_USER,
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

describe('RAILREPAY-WEB-BFF-004: POST /api/tickets/upload handler unit tests', () => {
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

    // Stub Redis: ownership store writes succeed
    mockRedis.set.mockResolvedValue('OK');

    // Build the test app: session middleware + upload route
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

  // ─── AC-1: Auth required ────────────────────────────────────────────────

  describe('AC-1: POST /api/tickets/upload — requires authenticated session', () => {
    it('AC-1: should return 401 { error: unauthorized } when no cookie and no Bearer', async () => {
      // No session set up
      mockRedis.get.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/tickets/upload')
        .attach('image', MINIMAL_JPEG_BUFFER, {
          filename: 'ticket.jpg',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: 'unauthorized' });
    });
  });

  // ─── AC-2: Happy path — JPEG upload → 200 { scan_id } ────────────────────

  describe('AC-2: multipart/form-data with `image` field — 200 { scan_id }', () => {
    it('AC-2: should return 200 { scan_id } for valid JPEG image with authenticated session', async () => {
      // Session lookup returns primary user
      mockRedis.get.mockResolvedValue(JSON.stringify({
        user_id: PRIMARY_USER.user_id,
        session_id: PRIMARY_USER.session_id,
        access_token: PRIMARY_USER.access_token,
        refresh_at_iso: PRIMARY_USER.refresh_at_iso,
        created_at_iso: PRIMARY_USER.created_at_iso,
      }));
      mockRedis.expire.mockResolvedValue(1);

      // Mocked: POST {OCR_SERVICE_URL}/ocr/scan
      // Verified real: services/ocr/src/handlers/scan.handler.ts createScanHandler
      // Exposed at: services/ocr/src/index.ts mounted at /ocr/scan
      // Last verified: 2026-04-27 (Jessie WEB-BFF-004 US-2)
      nock(OCR_BASE)
        .post('/ocr/scan')
        .reply(200, FULL_OCR_UPLOAD_RESPONSE);

      const res = await request(app)
        .post('/api/tickets/upload')
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`)
        .attach('image', MINIMAL_JPEG_BUFFER, {
          filename: 'ticket.jpg',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('scan_id');
      expect(res.body.scan_id).toBe(HAPPY_SCAN_ID);
      // BL-280: assert BFF forwards full OCR response, not just scan_id
      expect(res.body.extracted_fields).toEqual(FULL_OCR_UPLOAD_RESPONSE.extracted_fields);
      expect(res.body.raw_text).toBe(FULL_OCR_UPLOAD_RESPONSE.raw_text);
      expect(res.body.confidence).toBe(FULL_OCR_UPLOAD_RESPONSE.confidence);
      expect(res.body.missing_fields).toEqual(FULL_OCR_UPLOAD_RESPONSE.missing_fields);
      expect(res.body.claim_ready).toBe(FULL_OCR_UPLOAD_RESPONSE.claim_ready);
      expect(res.body.ocr_status).toBe(FULL_OCR_UPLOAD_RESPONSE.ocr_status);
      expect(res.body.gcs_upload_status).toBe(FULL_OCR_UPLOAD_RESPONSE.gcs_upload_status);
      expect(res.body.image_gcs_path).toBe(FULL_OCR_UPLOAD_RESPONSE.image_gcs_path);
    });

    it('AC-2: should return 200 { scan_id } for valid PNG image with authenticated session', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        user_id: PRIMARY_USER.user_id,
        session_id: PRIMARY_USER.session_id,
        access_token: PRIMARY_USER.access_token,
        refresh_at_iso: PRIMARY_USER.refresh_at_iso,
        created_at_iso: PRIMARY_USER.created_at_iso,
      }));
      mockRedis.expire.mockResolvedValue(1);

      nock(OCR_BASE)
        .post('/ocr/scan')
        .reply(200, { scan_id: '11111111-aaaa-4aaa-8aaa-111111111111' });

      const res = await request(app)
        .post('/api/tickets/upload')
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`)
        .attach('image', MINIMAL_PNG_BUFFER, {
          filename: 'ticket.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('scan_id');
      expect(res.body.scan_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('AC-2: should record scan ownership in Redis after successful upload', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        user_id: PRIMARY_USER.user_id,
        session_id: PRIMARY_USER.session_id,
        access_token: PRIMARY_USER.access_token,
        refresh_at_iso: PRIMARY_USER.refresh_at_iso,
        created_at_iso: PRIMARY_USER.created_at_iso,
      }));
      mockRedis.expire.mockResolvedValue(1);

      nock(OCR_BASE)
        .post('/ocr/scan')
        .reply(200, OCR_SCAN_RESPONSE);

      await request(app)
        .post('/api/tickets/upload')
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`)
        .attach('image', MINIMAL_JPEG_BUFFER, {
          filename: 'ticket.jpg',
          contentType: 'image/jpeg',
        });

      // Redis set must have been called to record scan ownership (bff:scan:<scanId>)
      const setCalls = mockRedis.set.mock.calls;
      const ownershipCall = setCalls.find(([key]: string[]) =>
        key === `bff:scan:${HAPPY_SCAN_ID}`
      );
      expect(ownershipCall).toBeDefined();
      // Value must be the user_id
      expect(ownershipCall![1]).toBe(PRIMARY_USER.user_id);
      // TTL must be 7776000 (90 days)
      expect(ownershipCall![2]).toBe('EX');
      expect(ownershipCall![3]).toBe(7776000);
    });
  });

  // ─── AC-3: Missing `image` field → 400 ──────────────────────────────────

  describe('AC-3: missing `image` field → 400 { error: image field is required }', () => {
    it('AC-3: should return 400 when no image field provided in multipart', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        user_id: PRIMARY_USER.user_id,
        session_id: PRIMARY_USER.session_id,
        access_token: PRIMARY_USER.access_token,
        refresh_at_iso: PRIMARY_USER.refresh_at_iso,
        created_at_iso: PRIMARY_USER.created_at_iso,
      }));
      mockRedis.expire.mockResolvedValue(1);

      // multipart with a different field name (not 'image')
      const res = await request(app)
        .post('/api/tickets/upload')
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`)
        .attach('wrong_field', MINIMAL_JPEG_BUFFER, {
          filename: 'ticket.jpg',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'image field is required' });
    });

    it('AC-3: should return 400 when request is entirely empty (no multipart body)', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        user_id: PRIMARY_USER.user_id,
        session_id: PRIMARY_USER.session_id,
        access_token: PRIMARY_USER.access_token,
        refresh_at_iso: PRIMARY_USER.refresh_at_iso,
        created_at_iso: PRIMARY_USER.created_at_iso,
      }));
      mockRedis.expire.mockResolvedValue(1);

      const res = await request(app)
        .post('/api/tickets/upload')
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`)
        .set('Content-Type', 'application/json')
        .send({});

      // Not multipart at all → either 400 or 415; BFF must not forward to OCR
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  });

  // ─── AC-4: Image >10MB → 413 pre-stream rejection ──────────────────────

  describe('AC-4: image >10MB → 413 { error: image too large, max_bytes: 10485760 } — pre-stream rejection', () => {
    it('AC-4: should return 413 with correct body for image exceeding 10MB', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        user_id: PRIMARY_USER.user_id,
        session_id: PRIMARY_USER.session_id,
        access_token: PRIMARY_USER.access_token,
        refresh_at_iso: PRIMARY_USER.refresh_at_iso,
        created_at_iso: PRIMARY_USER.created_at_iso,
      }));
      mockRedis.expire.mockResolvedValue(1);

      // OCR must NOT be called for oversized images
      const ocrScope = nock(OCR_BASE)
        .post('/ocr/scan')
        .reply(200, OCR_SCAN_RESPONSE);

      const res = await request(app)
        .post('/api/tickets/upload')
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`)
        .attach('image', OVERSIZED_BUFFER, {
          filename: 'oversized.jpg',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({
        error: 'image too large',
        max_bytes: 10485760,
      });
      // OCR must NOT have been called (pre-stream rejection)
      expect(ocrScope.isDone()).toBe(false);
    });

    it('AC-4: error response must specify max_bytes as exactly 10485760 (10*1024*1024)', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        user_id: PRIMARY_USER.user_id,
        session_id: PRIMARY_USER.session_id,
        access_token: PRIMARY_USER.access_token,
        refresh_at_iso: PRIMARY_USER.refresh_at_iso,
        created_at_iso: PRIMARY_USER.created_at_iso,
      }));
      mockRedis.expire.mockResolvedValue(1);

      nock(OCR_BASE).post('/ocr/scan').reply(200, OCR_SCAN_RESPONSE);

      const res = await request(app)
        .post('/api/tickets/upload')
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`)
        .attach('image', OVERSIZED_BUFFER, {
          filename: 'oversized.jpg',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(413);
      expect(res.body.max_bytes).toBe(10 * 1024 * 1024); // 10485760
    });
  });

  // ─── AC-5: Unsupported MIME type → 415 ──────────────────────────────────

  describe('AC-5: unsupported content_type → 415 { error, supported: [...] }', () => {
    it('AC-5: should return 415 for application/pdf (explicitly excluded per OQ-C)', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        user_id: PRIMARY_USER.user_id,
        session_id: PRIMARY_USER.session_id,
        access_token: PRIMARY_USER.access_token,
        refresh_at_iso: PRIMARY_USER.refresh_at_iso,
        created_at_iso: PRIMARY_USER.created_at_iso,
      }));
      mockRedis.expire.mockResolvedValue(1);

      // Construct a fake PDF buffer (PDF magic bytes)
      const pdfBuffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

      const res = await request(app)
        .post('/api/tickets/upload')
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`)
        .attach('image', pdfBuffer, {
          filename: 'ticket.pdf',
          contentType: 'application/pdf',
        });

      expect(res.status).toBe(415);
      expect(res.body).toMatchObject({
        error: 'unsupported content_type',
        supported: expect.arrayContaining(['image/jpeg', 'image/png']),
      });
    });

    it('AC-5: should return 415 for image/heic (excluded per OQ-C beta scope)', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        user_id: PRIMARY_USER.user_id,
        session_id: PRIMARY_USER.session_id,
        access_token: PRIMARY_USER.access_token,
        refresh_at_iso: PRIMARY_USER.refresh_at_iso,
        created_at_iso: PRIMARY_USER.created_at_iso,
      }));
      mockRedis.expire.mockResolvedValue(1);

      const heicBuffer = Buffer.alloc(32, 0xaa);

      const res = await request(app)
        .post('/api/tickets/upload')
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`)
        .attach('image', heicBuffer, {
          filename: 'ticket.heic',
          contentType: 'image/heic',
        });

      expect(res.status).toBe(415);
      expect(res.body.supported).toEqual(['image/jpeg', 'image/png']);
    });

    it('AC-5: should return 415 for image/webp (not in scope)', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        user_id: PRIMARY_USER.user_id,
        session_id: PRIMARY_USER.session_id,
        access_token: PRIMARY_USER.access_token,
        refresh_at_iso: PRIMARY_USER.refresh_at_iso,
        created_at_iso: PRIMARY_USER.created_at_iso,
      }));
      mockRedis.expire.mockResolvedValue(1);

      const webpBuffer = Buffer.alloc(16, 0xbb);

      const res = await request(app)
        .post('/api/tickets/upload')
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`)
        .attach('image', webpBuffer, {
          filename: 'ticket.webp',
          contentType: 'image/webp',
        });

      expect(res.status).toBe(415);
    });

    it('AC-5: should NOT return 415 for image/jpeg (accepted MIME)', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        user_id: PRIMARY_USER.user_id,
        session_id: PRIMARY_USER.session_id,
        access_token: PRIMARY_USER.access_token,
        refresh_at_iso: PRIMARY_USER.refresh_at_iso,
        created_at_iso: PRIMARY_USER.created_at_iso,
      }));
      mockRedis.expire.mockResolvedValue(1);

      nock(OCR_BASE).post('/ocr/scan').reply(200, OCR_SCAN_RESPONSE);

      const res = await request(app)
        .post('/api/tickets/upload')
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`)
        .attach('image', MINIMAL_JPEG_BUFFER, {
          filename: 'ticket.jpg',
          contentType: 'image/jpeg',
        });

      expect(res.status).not.toBe(415);
    });

    it('AC-5: should NOT return 415 for image/png (accepted MIME)', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        user_id: PRIMARY_USER.user_id,
        session_id: PRIMARY_USER.session_id,
        access_token: PRIMARY_USER.access_token,
        refresh_at_iso: PRIMARY_USER.refresh_at_iso,
        created_at_iso: PRIMARY_USER.created_at_iso,
      }));
      mockRedis.expire.mockResolvedValue(1);

      nock(OCR_BASE).post('/ocr/scan').reply(200, { scan_id: '22222222-bbbb-4bbb-8bbb-222222222222' });

      const res = await request(app)
        .post('/api/tickets/upload')
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`)
        .attach('image', MINIMAL_PNG_BUFFER, {
          filename: 'ticket.png',
          contentType: 'image/png',
        });

      expect(res.status).not.toBe(415);
    });
  });

  // ─── AC-6: Forwards to OCR with correct JSON body ─────────────────────

  describe('AC-6: forwards image to ocr via POST /ocr/scan with correct JSON body', () => {
    it('AC-6: should forward image_base64, content_type, user_id, correlation_id to ocr', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        user_id: PRIMARY_USER.user_id,
        session_id: PRIMARY_USER.session_id,
        access_token: PRIMARY_USER.access_token,
        refresh_at_iso: PRIMARY_USER.refresh_at_iso,
        created_at_iso: PRIMARY_USER.created_at_iso,
      }));
      mockRedis.expire.mockResolvedValue(1);

      let capturedBody: Record<string, unknown> = {};
      // Mocked: POST {OCR_SERVICE_URL}/ocr/scan
      // Verified real: services/ocr/src/handlers/scan.handler.ts createScanHandler
      // Exposed at: services/ocr/src/index.ts mounted at /ocr/scan
      // Last verified: 2026-04-27 (Jessie WEB-BFF-004 US-2)
      nock(OCR_BASE)
        .post('/ocr/scan', (body: Record<string, unknown>) => {
          capturedBody = body;
          return true;
        })
        .reply(200, OCR_SCAN_RESPONSE);

      await request(app)
        .post('/api/tickets/upload')
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`)
        .set('x-correlation-id', 'corr-ac6-body-0001')
        .attach('image', MINIMAL_JPEG_BUFFER, {
          filename: 'ticket.jpg',
          contentType: 'image/jpeg',
        });

      // Verify outbound body shape (AC-6)
      expect(capturedBody).toHaveProperty('image_base64');
      expect(capturedBody).toHaveProperty('content_type', 'image/jpeg');
      expect(capturedBody).toHaveProperty('user_id', PRIMARY_USER.user_id);
      expect(capturedBody).toHaveProperty('correlation_id');
      // image_base64 must be a valid base64 string
      expect(typeof capturedBody.image_base64).toBe('string');
      expect(() => Buffer.from(capturedBody.image_base64 as string, 'base64')).not.toThrow();
    });
  });

  // ─── AC-7: Optional `source` field ───────────────────────────────────────

  describe('AC-7: optional multipart text field `source` forwarded to ocr', () => {
    it('AC-7: should forward source=camera when provided as multipart text field', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        user_id: PRIMARY_USER.user_id,
        session_id: PRIMARY_USER.session_id,
        access_token: PRIMARY_USER.access_token,
        refresh_at_iso: PRIMARY_USER.refresh_at_iso,
        created_at_iso: PRIMARY_USER.created_at_iso,
      }));
      mockRedis.expire.mockResolvedValue(1);

      let capturedBody: Record<string, unknown> = {};
      nock(OCR_BASE)
        .post('/ocr/scan', (body: Record<string, unknown>) => {
          capturedBody = body;
          return true;
        })
        .reply(200, OCR_SCAN_RESPONSE);

      await request(app)
        .post('/api/tickets/upload')
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`)
        .attach('image', MINIMAL_JPEG_BUFFER, {
          filename: 'ticket.jpg',
          contentType: 'image/jpeg',
        })
        .field('source', 'camera');

      expect(capturedBody.source).toBe('camera');
    });

    it('AC-7: should forward source=screenshot when provided', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        user_id: PRIMARY_USER.user_id,
        session_id: PRIMARY_USER.session_id,
        access_token: PRIMARY_USER.access_token,
        refresh_at_iso: PRIMARY_USER.refresh_at_iso,
        created_at_iso: PRIMARY_USER.created_at_iso,
      }));
      mockRedis.expire.mockResolvedValue(1);

      let capturedBody: Record<string, unknown> = {};
      nock(OCR_BASE)
        .post('/ocr/scan', (body: Record<string, unknown>) => {
          capturedBody = body;
          return true;
        })
        .reply(200, OCR_SCAN_RESPONSE);

      await request(app)
        .post('/api/tickets/upload')
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`)
        .attach('image', MINIMAL_JPEG_BUFFER, {
          filename: 'ticket.jpg',
          contentType: 'image/jpeg',
        })
        .field('source', 'screenshot');

      expect(capturedBody.source).toBe('screenshot');
    });

    it('AC-7: should NOT include source in ocr body when source is omitted (not sent as unknown)', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        user_id: PRIMARY_USER.user_id,
        session_id: PRIMARY_USER.session_id,
        access_token: PRIMARY_USER.access_token,
        refresh_at_iso: PRIMARY_USER.refresh_at_iso,
        created_at_iso: PRIMARY_USER.created_at_iso,
      }));
      mockRedis.expire.mockResolvedValue(1);

      let capturedBody: Record<string, unknown> = {};
      nock(OCR_BASE)
        .post('/ocr/scan', (body: Record<string, unknown>) => {
          capturedBody = body;
          return true;
        })
        .reply(200, OCR_SCAN_RESPONSE);

      await request(app)
        .post('/api/tickets/upload')
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`)
        .attach('image', MINIMAL_JPEG_BUFFER, {
          filename: 'ticket.jpg',
          contentType: 'image/jpeg',
        });
        // source NOT added as a field

      // source must be absent — NOT forwarded as 'unknown' (AC-7 OQ-A)
      expect(capturedBody).not.toHaveProperty('source');
    });
  });

  // ─── AC-13: OCR error mapping ────────────────────────────────────────────

  describe('AC-13: OCR error mapping — 503 on timeout/5xx, 502 on unexpected 4xx', () => {
    it('AC-13: should return 503 { error: ocr_unavailable } when ocr returns 503', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        user_id: PRIMARY_USER.user_id,
        session_id: PRIMARY_USER.session_id,
        access_token: PRIMARY_USER.access_token,
        refresh_at_iso: PRIMARY_USER.refresh_at_iso,
        created_at_iso: PRIMARY_USER.created_at_iso,
      }));
      mockRedis.expire.mockResolvedValue(1);

      nock(OCR_BASE)
        .post('/ocr/scan')
        .reply(503, { error: 'service_unavailable' });

      const res = await request(app)
        .post('/api/tickets/upload')
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`)
        .attach('image', MINIMAL_JPEG_BUFFER, {
          filename: 'ticket.jpg',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ error: 'ocr_unavailable' });
    });

    it('AC-13: should return 502 { error: ocr_error, upstream_status } on unexpected ocr 4xx', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        user_id: PRIMARY_USER.user_id,
        session_id: PRIMARY_USER.session_id,
        access_token: PRIMARY_USER.access_token,
        refresh_at_iso: PRIMARY_USER.refresh_at_iso,
        created_at_iso: PRIMARY_USER.created_at_iso,
      }));
      mockRedis.expire.mockResolvedValue(1);

      nock(OCR_BASE)
        .post('/ocr/scan')
        .reply(422, { error: 'unprocessable_entity' });

      const res = await request(app)
        .post('/api/tickets/upload')
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`)
        .attach('image', MINIMAL_JPEG_BUFFER, {
          filename: 'ticket.jpg',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({
        error: 'ocr_error',
        upstream_status: 422,
      });
    });
  });
});
