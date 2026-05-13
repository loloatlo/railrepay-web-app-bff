/**
 * Integration Tests: tickets flow — POST /api/tickets/upload → GET /api/tickets/:scanId
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
 *   src/handlers/get-ticket-scan.handler.ts
 *   src/routes/tickets.ts
 *   src/lib/ocr-service-client.ts
 *   src/lib/scan-ownership-store.ts
 *
 * Failure reason: "Cannot find module" or 404 from routes not mounted.
 *
 * AC coverage map (integration focus per CLAUDE.md §7.1 Phase US-4):
 *   AC-1:  POST /api/tickets/upload — 401 when no auth (integration: real Redis confirms no session)
 *   AC-2:  POST upload success → Redis bff:scan:<scanId> key written with correct user_id + 90d TTL
 *   AC-6:  nock asserts outbound JSON body to ocr matches { image_base64, content_type, user_id, correlation_id }
 *   AC-8:  GET /api/tickets/:scanId — 401 when no auth
 *   AC-11: GET /api/tickets/:scanId — second user's request returns 403 (scoping enforced via real Redis)
 *   AC-16: Coverage ≥80%/≥75%; integration asserts full POST→GET happy path AND auth-rejected,
 *          oversized, unscoped-user paths via Testcontainers Redis + nock
 *
 * Infrastructure:
 *   - Testcontainers Redis (real I/O — no mock)
 *   - nock for ocr-service HTTP stubbing
 *   - Real @railrepay/winston-logger (no vi.mock for it — AC-16 infrastructure verification)
 *   - supertest for HTTP
 *
 * AC-16 annotation (CLAUDE.md §6.1 #8 shared package verification):
 *   NO vi.mock('@railrepay/winston-logger') in this file — real package imported
 *   NO vi.mock('@railrepay/redis-cache') in this file — real package imported
 *
 * Mocked HTTP (nock):
 *   // Mocked: POST {OCR_SERVICE_URL}/ocr/scan
 *   // Verified real: services/ocr/src/handlers/scan.handler.ts createScanHandler
 *   // Exposed at: services/ocr/src/index.ts mounted at /ocr/scan
 *   // Last verified: 2026-04-27 (Jessie WEB-BFF-004 US-2)
 *
 *   // Mocked: GET {OCR_SERVICE_URL}/ocr/results/:scanId
 *   // Verified real: services/ocr/src/handlers/results.handler.ts createResultsHandler
 *   // Exposed at: services/ocr/src/index.ts mounted at /ocr/results/:scanId
 *   // Last verified: 2026-04-27 (Jessie WEB-BFF-004 US-2)
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §7 — Integration tests required
 *   CLAUDE.md §6.1 #10 — Mocked Endpoint Verification
 *   CLAUDE.md §8 — Mandatory shared package usage (verified here via real imports)
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import nock from 'nock';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  MINIMAL_JPEG_BUFFER,
  MINIMAL_PNG_BUFFER,
  OVERSIZED_BUFFER,
  OCR_SCAN_RESPONSE,
  OCR_RESULTS_RESPONSE,
  FULL_OCR_UPLOAD_RESPONSE,
  HAPPY_SCAN_ID,
  PRIMARY_USER,
  SECOND_USER,
  SCAN_OWNERSHIP_TTL_SECONDS,
} from '../fixtures/scan-data.js';

// ─── AC-16: Real shared packages — NO vi.mock for @railrepay/* in this file ───
// INTENTIONALLY not mocking @railrepay/winston-logger
// This integration test MUST exercise the real package implementations.

// ─── OCR stub base URL ─────────────────────────────────────────────────────────
const OCR_BASE = 'http://ocr-integration-stub-004.test';

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-004: tickets flow integration tests (Testcontainers Redis)', () => {
  let container: StartedTestContainer;
  let redis: Redis;
  let app: ReturnType<typeof express>;

  beforeAll(async () => {
    // Start real Redis via Testcontainers
    container = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .start();

    const redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
    redis = new Redis(redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 0 });

    // Environment configuration
    process.env.OCR_SERVICE_URL = OCR_BASE;
    process.env.SESSION_COOKIE_NAME = 'rr_session';
    process.env.JWT_SECRET = 'test-secret-32-chars-minimum-aaa';
    process.env.JWT_ISSUER = 'auth-service';
    process.env.JWT_AUDIENCE = 'web-app-bff';
    process.env.NODE_ENV = 'test';
    process.env.AUTH_SERVICE_URL = 'http://auth-service-integration-bff-004:9993';

    nock.cleanAll();

    // @ts-expect-error — module does not exist yet (TDD RED phase)
    const { createTicketsRouter } = await import('../../src/routes/tickets.js');
    // @ts-expect-error — module does not exist yet (TDD RED phase)
    const { createCookieSessionMiddleware } = await import('../../src/middleware/cookie-session.js');
    // @ts-expect-error — module does not exist yet (TDD RED phase)
    const { createBearerFallbackMiddleware } = await import('../../src/middleware/bearer-fallback.js');

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(createCookieSessionMiddleware(redis));
    app.use(createBearerFallbackMiddleware());
    app.use(createTicketsRouter(redis));
  }, 120000);

  afterAll(async () => {
    nock.cleanAll();
    await redis.quit();
    await container.stop();
    delete process.env.OCR_SERVICE_URL;
    delete process.env.SESSION_COOKIE_NAME;
    delete process.env.JWT_SECRET;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    delete process.env.NODE_ENV;
    delete process.env.AUTH_SERVICE_URL;
  });

  beforeEach(() => {
    nock.cleanAll();
  });

  // Helper: write a session directly to real Redis (simulating post-verify state)
  async function writeSession(user: typeof PRIMARY_USER): Promise<void> {
    const sessionData = {
      user_id: user.user_id,
      session_id: user.session_id,
      access_token: user.access_token,
      refresh_at_iso: user.refresh_at_iso,
      created_at_iso: user.created_at_iso,
    };
    await redis.set(`bff:session:${user.session_id}`, JSON.stringify(sessionData), 'EX', 2592000);
  }

  // ─── AC-1: Full POST→GET happy path with real Redis ──────────────────────

  describe('AC-2, AC-6, AC-11 (AC-16): full POST→GET happy path with real Redis + nock ocr', () => {
    it('AC-2+AC-6: POST /api/tickets/upload → 200 {scan_id}; Redis bff:scan:<scanId> written with 90d TTL', async () => {
      // Set up primary user session in real Redis
      await writeSession(PRIMARY_USER);

      // Mocked: POST {OCR_SERVICE_URL}/ocr/scan
      // Verified real: services/ocr/src/handlers/scan.handler.ts createScanHandler
      // Exposed at: services/ocr/src/index.ts mounted at /ocr/scan
      // Last verified: 2026-04-27 (Jessie WEB-BFF-004 US-2)
      const ocrScope = nock(OCR_BASE)
        .post('/ocr/scan', (body: Record<string, unknown>) => {
          // AC-6: verify outbound JSON body has required fields
          return (
            typeof body.image_base64 === 'string' &&
            body.content_type === 'image/jpeg' &&
            body.user_id === PRIMARY_USER.user_id &&
            typeof body.correlation_id === 'string'
          );
        })
        .reply(200, FULL_OCR_UPLOAD_RESPONSE);

      const uploadRes = await request(app)
        .post('/api/tickets/upload')
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`)
        .set('x-correlation-id', 'integration-corr-ac2-0001')
        .attach('image', MINIMAL_JPEG_BUFFER, {
          filename: 'ticket.jpg',
          contentType: 'image/jpeg',
        });

      // AC-2: 200 { scan_id }
      expect(uploadRes.status).toBe(200);
      expect(uploadRes.body).toHaveProperty('scan_id', HAPPY_SCAN_ID);
      // BL-280: integration verifies BFF forwards full OCR response over the wire
      expect(uploadRes.body.extracted_fields).toEqual(FULL_OCR_UPLOAD_RESPONSE.extracted_fields);
      expect(uploadRes.body.raw_text).toBe(FULL_OCR_UPLOAD_RESPONSE.raw_text);
      expect(uploadRes.body.claim_ready).toBe(FULL_OCR_UPLOAD_RESPONSE.claim_ready);

      // AC-6: nock interceptor was called (verifies outbound HTTP to ocr)
      expect(ocrScope.isDone()).toBe(true);

      // AC-2 (Redis verification): bff:scan:<scanId> must be written with user_id
      const ownershipKey = `bff:scan:${HAPPY_SCAN_ID}`;
      const ownerValue = await redis.get(ownershipKey);
      expect(ownerValue).toBe(PRIMARY_USER.user_id);

      // AC-2 (Redis TTL verification): TTL must be ~90 days (7776000s)
      const ttl = await redis.ttl(ownershipKey);
      // TTL should be within 5 seconds of 7776000
      expect(ttl).toBeGreaterThan(SCAN_OWNERSHIP_TTL_SECONDS - 5);
      expect(ttl).toBeLessThanOrEqual(SCAN_OWNERSHIP_TTL_SECONDS);
    });

    it('AC-10: GET /api/tickets/:scanId → 200 with verbatim ocr fields after POST', async () => {
      await writeSession(PRIMARY_USER);
      // Ownership key already written by previous test or write manually
      await redis.set(`bff:scan:${HAPPY_SCAN_ID}`, PRIMARY_USER.user_id, 'EX', SCAN_OWNERSHIP_TTL_SECONDS);

      // Mocked: GET {OCR_SERVICE_URL}/ocr/results/:scanId
      // Verified real: services/ocr/src/handlers/results.handler.ts createResultsHandler
      // Exposed at: services/ocr/src/index.ts mounted at /ocr/results/:scanId
      // Last verified: 2026-04-27 (Jessie WEB-BFF-004 US-2)
      const ocrScope = nock(OCR_BASE)
        .get(`/ocr/results/${HAPPY_SCAN_ID}`)
        .reply(200, OCR_RESULTS_RESPONSE);

      const getRes = await request(app)
        .get(`/api/tickets/${HAPPY_SCAN_ID}`)
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`);

      expect(getRes.status).toBe(200);
      expect(ocrScope.isDone()).toBe(true);
      expect(getRes.body.scan_id).toBe(HAPPY_SCAN_ID);
      expect(getRes.body.status).toBe('completed');
      expect(getRes.body.claim_ready).toBe(true);
    });
  });

  // ─── AC-1: POST auth-rejected path (real Redis — no session) ─────────────

  describe('AC-1 (AC-16): POST /api/tickets/upload — 401 when no session', () => {
    it('AC-1: should return 401 when no cookie and no session in real Redis', async () => {
      // No session written to Redis

      const res = await request(app)
        .post('/api/tickets/upload')
        .attach('image', MINIMAL_PNG_BUFFER, {
          filename: 'ticket.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: 'unauthorized' });
    });
  });

  // ─── AC-8: GET auth-rejected path (real Redis — no session) ──────────────

  describe('AC-8 (AC-16): GET /api/tickets/:scanId — 401 when no session', () => {
    it('AC-8: should return 401 when no cookie and no session in real Redis', async () => {
      const res = await request(app)
        .get(`/api/tickets/${HAPPY_SCAN_ID}`);

      expect(res.status).toBe(401);
    });
  });

  // ─── AC-16 + AC-4: Oversized upload path (real Redis session) ────────────

  describe('AC-4 (AC-16): oversized upload → 413 via real Redis session + busboy', () => {
    it('AC-4: should return 413 for >10MB image using real Redis session', async () => {
      await writeSession(PRIMARY_USER);

      // OCR must NOT be called
      const ocrScope = nock(OCR_BASE).post('/ocr/scan').reply(200, OCR_SCAN_RESPONSE);

      const res = await request(app)
        .post('/api/tickets/upload')
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`)
        .attach('image', OVERSIZED_BUFFER, {
          filename: 'too-large.jpg',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({
        error: 'image too large',
        max_bytes: 10485760,
      });
      // Pre-stream rejection: OCR must NOT have been called
      expect(ocrScope.isDone()).toBe(false);
    });
  });

  // ─── AC-11: Second user 403 scoping path (real Redis — CRITICAL per CLAUDE.md §11) ─

  describe('AC-11 (AC-16): user scoping — second user 403 (real Redis + nock)', () => {
    it('AC-11: second user request on primary user scan_id → 403 { error: forbidden }', async () => {
      // Set up BOTH user sessions in real Redis
      await writeSession(PRIMARY_USER);
      await writeSession(SECOND_USER);

      // PRIMARY_USER uploads scan → ownership key written
      const uploadOcrScope = nock(OCR_BASE)
        .post('/ocr/scan')
        .reply(200, OCR_SCAN_RESPONSE);

      const uploadRes = await request(app)
        .post('/api/tickets/upload')
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`)
        .attach('image', MINIMAL_JPEG_BUFFER, {
          filename: 'ticket.jpg',
          contentType: 'image/jpeg',
        });

      expect(uploadRes.status).toBe(200);
      expect(uploadOcrScope.isDone()).toBe(true);

      const uploadedScanId = uploadRes.body.scan_id as string;

      // Verify ownership in real Redis
      const ownershipKey = `bff:scan:${uploadedScanId}`;
      const ownerValue = await redis.get(ownershipKey);
      expect(ownerValue).toBe(PRIMARY_USER.user_id);

      // SECOND_USER tries to access PRIMARY_USER's scan → must get 403
      const secondUserGetRes = await request(app)
        .get(`/api/tickets/${uploadedScanId}`)
        .set('Cookie', `rr_session=${SECOND_USER.session_id}`);

      expect(secondUserGetRes.status).toBe(403);
      expect(secondUserGetRes.body).toMatchObject({ error: 'forbidden' });
    });

    it('AC-11: PRIMARY_USER can access their OWN scan (same user → 200)', async () => {
      await writeSession(PRIMARY_USER);

      // Write ownership key directly for this scan
      const ownScanId = '33333333-cccc-4ccc-8ccc-333333333333';
      await redis.set(`bff:scan:${ownScanId}`, PRIMARY_USER.user_id, 'EX', SCAN_OWNERSHIP_TTL_SECONDS);

      // Mocked: GET {OCR_SERVICE_URL}/ocr/results/:scanId
      // Verified real: services/ocr/src/handlers/results.handler.ts createResultsHandler
      // Exposed at: services/ocr/src/index.ts mounted at /ocr/results/:scanId
      // Last verified: 2026-04-27 (Jessie WEB-BFF-004 US-2)
      nock(OCR_BASE)
        .get(`/ocr/results/${ownScanId}`)
        .reply(200, {
          ...OCR_RESULTS_RESPONSE,
          scan_id: ownScanId,
        });

      const res = await request(app)
        .get(`/api/tickets/${ownScanId}`)
        .set('Cookie', `rr_session=${PRIMARY_USER.session_id}`);

      expect(res.status).toBe(200);
      expect(res.body.scan_id).toBe(ownScanId);
    });
  });
});
