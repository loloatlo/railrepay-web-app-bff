/**
 * Unit Tests: ocr-service-client
 *
 * Story   : RAILREPAY-WEB-BFF-004
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-27
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates src/lib/ocr-service-client.ts.
 * Failure reason: "Cannot find module '../../src/lib/ocr-service-client.js'"
 *
 * AC coverage map:
 *   AC-6:  submitScan POSTs to {OCR_SERVICE_URL}/ocr/scan with JSON body
 *          {image_base64, content_type, user_id, correlation_id, source?}
 *   AC-13: 5s AbortController timeout on ALL ocr-service-client calls.
 *          On timeout → rejects with error that caller maps to 503.
 *          On ocr 5xx → caller maps to 503.
 *          On unexpected ocr 4xx → caller maps to 502.
 *   AC-14: x-correlation-id forwarded to ocr in BOTH submitScan and getScanResult.
 *          If absent in inbound request, BFF generates one before forwarding.
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
 *   CLAUDE.md §6.1 #10 — Mocked Endpoint Verification
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import {
  HAPPY_SCAN_ID,
  SECOND_SCAN_ID,
  PRIMARY_USER,
  OCR_SCAN_RESPONSE,
  OCR_RESULTS_RESPONSE,
  MINIMAL_JPEG_BUFFER,
  MINIMAL_PNG_BUFFER,
} from '../../fixtures/scan-data.js';

// ─── OCR_SERVICE_URL stub (vitest.config.ts test.env: OCR_SERVICE_URL=http://ocr-stub.test) ─
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

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-004: ocr-service-client unit tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nock.cleanAll();
    process.env.OCR_SERVICE_URL = OCR_BASE;
  });

  afterEach(() => {
    nock.cleanAll();
    vi.restoreAllMocks();
    delete process.env.OCR_SERVICE_URL;
  });

  // ─── AC-6: submitScan POSTs correct JSON body to /ocr/scan ───────────────

  describe('AC-6: submitScan — POSTs JSON body to {OCR_SERVICE_URL}/ocr/scan', () => {
    it('AC-6: should POST image_base64, content_type, user_id, correlation_id to /ocr/scan', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { submitScan } = await import('../../../src/lib/ocr-service-client.js');

      const imageBase64 = MINIMAL_JPEG_BUFFER.toString('base64');
      const correlationId = 'corr-ac6-jpeg-0001';

      // Mocked: POST {OCR_SERVICE_URL}/ocr/scan
      // Verified real: services/ocr/src/handlers/scan.handler.ts createScanHandler
      // Exposed at: services/ocr/src/index.ts mounted at /ocr/scan
      // Last verified: 2026-04-27 (Jessie WEB-BFF-004 US-2)
      const scope = nock(OCR_BASE)
        .post('/ocr/scan', {
          image_base64: imageBase64,
          content_type: 'image/jpeg',
          user_id: PRIMARY_USER.user_id,
          correlation_id: correlationId,
        })
        .reply(200, OCR_SCAN_RESPONSE);

      const result = await submitScan({
        imageBase64,
        contentType: 'image/jpeg',
        userId: PRIMARY_USER.user_id,
        correlationId,
      });

      expect(scope.isDone()).toBe(true);
      expect(result).toMatchObject({ statusCode: 200, body: OCR_SCAN_RESPONSE });
    });

    it('AC-6: should POST PNG image_base64 with content_type=image/png', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { submitScan } = await import('../../../src/lib/ocr-service-client.js');

      const imageBase64 = MINIMAL_PNG_BUFFER.toString('base64');
      const correlationId = 'corr-ac6-png-0001';

      const scope = nock(OCR_BASE)
        .post('/ocr/scan', (body: Record<string, unknown>) => {
          return (
            body.content_type === 'image/png' &&
            body.image_base64 === imageBase64 &&
            body.user_id === PRIMARY_USER.user_id
          );
        })
        .reply(200, { scan_id: SECOND_SCAN_ID });

      const result = await submitScan({
        imageBase64,
        contentType: 'image/png',
        userId: PRIMARY_USER.user_id,
        correlationId,
      });

      expect(scope.isDone()).toBe(true);
      expect(result.statusCode).toBe(200);
    });

    it('AC-7: should include source field in JSON body when source is provided', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { submitScan } = await import('../../../src/lib/ocr-service-client.js');

      const imageBase64 = MINIMAL_JPEG_BUFFER.toString('base64');
      const correlationId = 'corr-ac7-source-0001';

      const scope = nock(OCR_BASE)
        .post('/ocr/scan', (body: Record<string, unknown>) => {
          return body.source === 'camera' && body.image_base64 === imageBase64;
        })
        .reply(200, OCR_SCAN_RESPONSE);

      const result = await submitScan({
        imageBase64,
        contentType: 'image/jpeg',
        userId: PRIMARY_USER.user_id,
        correlationId,
        source: 'camera',
      });

      expect(scope.isDone()).toBe(true);
      expect(result.statusCode).toBe(200);
    });

    it('AC-7: should NOT include source field when source is omitted', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { submitScan } = await import('../../../src/lib/ocr-service-client.js');

      const imageBase64 = MINIMAL_JPEG_BUFFER.toString('base64');
      const correlationId = 'corr-ac7-no-source-0001';

      let capturedBody: Record<string, unknown> = {};
      const scope = nock(OCR_BASE)
        .post('/ocr/scan', (body: Record<string, unknown>) => {
          capturedBody = body;
          return true;
        })
        .reply(200, OCR_SCAN_RESPONSE);

      await submitScan({
        imageBase64,
        contentType: 'image/jpeg',
        userId: PRIMARY_USER.user_id,
        correlationId,
        // source intentionally omitted
      });

      expect(scope.isDone()).toBe(true);
      // source must NOT be present in the outbound body (not as 'unknown', not as null)
      expect(capturedBody).not.toHaveProperty('source');
    });
  });

  // ─── AC-14: x-correlation-id forwarded in submitScan ────────────────────

  describe('AC-14: correlation-id propagation in submitScan', () => {
    it('AC-14: should forward x-correlation-id header to /ocr/scan', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { submitScan } = await import('../../../src/lib/ocr-service-client.js');

      const imageBase64 = MINIMAL_JPEG_BUFFER.toString('base64');
      const correlationId = 'corr-ac14-submit-0001';

      const scope = nock(OCR_BASE)
        .post('/ocr/scan')
        .matchHeader('x-correlation-id', correlationId)
        .reply(200, OCR_SCAN_RESPONSE);

      await submitScan({
        imageBase64,
        contentType: 'image/jpeg',
        userId: PRIMARY_USER.user_id,
        correlationId,
      });

      expect(scope.isDone()).toBe(true);
    });

    it('AC-14: should forward x-correlation-id header to /ocr/results/:scanId', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getScanResult } = await import('../../../src/lib/ocr-service-client.js');

      const correlationId = 'corr-ac14-results-0001';

      // Mocked: GET {OCR_SERVICE_URL}/ocr/results/:scanId
      // Verified real: services/ocr/src/handlers/results.handler.ts createResultsHandler
      // Exposed at: services/ocr/src/index.ts mounted at /ocr/results/:scanId
      // Last verified: 2026-04-27 (Jessie WEB-BFF-004 US-2)
      const scope = nock(OCR_BASE)
        .get(`/ocr/results/${HAPPY_SCAN_ID}`)
        .matchHeader('x-correlation-id', correlationId)
        .reply(200, OCR_RESULTS_RESPONSE);

      await getScanResult({
        scanId: HAPPY_SCAN_ID,
        correlationId,
      });

      expect(scope.isDone()).toBe(true);
    });
  });

  // ─── AC-13: 5s timeout on submitScan ─────────────────────────────────────

  describe('AC-13: 5s AbortController timeout on submitScan', () => {
    it('AC-13: should reject (propagate error) when ocr-service takes longer than 5s', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { submitScan } = await import('../../../src/lib/ocr-service-client.js');

      vi.useFakeTimers();

      // ocr-service delays indefinitely — nock will hold the request open
      // We use a long delay so the fake timer fires first
      nock(OCR_BASE)
        .post('/ocr/scan')
        .delay(30000) // 30s delay — fake timers advance past 5s
        .reply(200, OCR_SCAN_RESPONSE);

      const imageBase64 = MINIMAL_JPEG_BUFFER.toString('base64');

      const promise = submitScan({
        imageBase64,
        contentType: 'image/jpeg',
        userId: PRIMARY_USER.user_id,
        correlationId: 'corr-ac13-timeout-0001',
      });

      // Advance fake timers past the 5s timeout
      vi.advanceTimersByTime(6000);

      await expect(promise).rejects.toThrow();

      vi.useRealTimers();
    });

    it('AC-13: should return 5xx body (statusCode 503+) when ocr returns 503', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { submitScan } = await import('../../../src/lib/ocr-service-client.js');

      nock(OCR_BASE)
        .post('/ocr/scan')
        .reply(503, { error: 'service_unavailable' });

      const result = await submitScan({
        imageBase64: MINIMAL_JPEG_BUFFER.toString('base64'),
        contentType: 'image/jpeg',
        userId: PRIMARY_USER.user_id,
        correlationId: 'corr-ac13-5xx-0001',
      });

      // Client returns statusCode so handlers can map it
      expect(result.statusCode).toBe(503);
    });

    it('AC-13: should return 4xx statusCode when ocr returns unexpected 4xx', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { submitScan } = await import('../../../src/lib/ocr-service-client.js');

      nock(OCR_BASE)
        .post('/ocr/scan')
        .reply(422, { error: 'unprocessable_entity' });

      const result = await submitScan({
        imageBase64: MINIMAL_JPEG_BUFFER.toString('base64'),
        contentType: 'image/jpeg',
        userId: PRIMARY_USER.user_id,
        correlationId: 'corr-ac13-4xx-0001',
      });

      expect(result.statusCode).toBe(422);
    });
  });

  // ─── AC-13: 5s timeout on getScanResult ─────────────────────────────────

  describe('AC-13: 5s AbortController timeout on getScanResult', () => {
    it('AC-13: should reject when getScanResult takes longer than 5s', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getScanResult } = await import('../../../src/lib/ocr-service-client.js');

      vi.useFakeTimers();

      nock(OCR_BASE)
        .get(`/ocr/results/${HAPPY_SCAN_ID}`)
        .delay(30000)
        .reply(200, OCR_RESULTS_RESPONSE);

      const promise = getScanResult({
        scanId: HAPPY_SCAN_ID,
        correlationId: 'corr-ac13-get-timeout-0001',
      });

      vi.advanceTimersByTime(6000);

      await expect(promise).rejects.toThrow();

      vi.useRealTimers();
    });

    it('AC-13: should return 200 body when ocr returns results successfully', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getScanResult } = await import('../../../src/lib/ocr-service-client.js');

      nock(OCR_BASE)
        .get(`/ocr/results/${HAPPY_SCAN_ID}`)
        .reply(200, OCR_RESULTS_RESPONSE);

      const result = await getScanResult({
        scanId: HAPPY_SCAN_ID,
        correlationId: 'corr-ac13-get-200-0001',
      });

      expect(result.statusCode).toBe(200);
      expect(result.body).toMatchObject({ scan_id: HAPPY_SCAN_ID });
    });

    it('AC-13: should return 404 body when ocr returns 404 for scan', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getScanResult } = await import('../../../src/lib/ocr-service-client.js');

      const missingScanId = '00000000-0000-4000-8000-000000000001';
      nock(OCR_BASE)
        .get(`/ocr/results/${missingScanId}`)
        .reply(404, { error: `Scan not found: ${missingScanId}` });

      const result = await getScanResult({
        scanId: missingScanId,
        correlationId: 'corr-ac13-get-404-0001',
      });

      expect(result.statusCode).toBe(404);
    });
  });

  // ─── Infrastructure: no console.log ───────────────────────────────────────

  describe('Infrastructure: ocr-service-client must use @railrepay/winston-logger', () => {
    it('should not call console.log, console.error, or console.warn', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { submitScan } = await import('../../../src/lib/ocr-service-client.js');

      const consoleSpy = {
        log: vi.spyOn(console, 'log').mockImplementation(() => {}),
        error: vi.spyOn(console, 'error').mockImplementation(() => {}),
        warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      };

      nock(OCR_BASE).post('/ocr/scan').reply(200, OCR_SCAN_RESPONSE);

      await submitScan({
        imageBase64: MINIMAL_JPEG_BUFFER.toString('base64'),
        contentType: 'image/jpeg',
        userId: PRIMARY_USER.user_id,
        correlationId: 'corr-infra-logger-0001',
      });

      expect(consoleSpy.log).not.toHaveBeenCalled();
      expect(consoleSpy.error).not.toHaveBeenCalled();
      expect(consoleSpy.warn).not.toHaveBeenCalled();

      consoleSpy.log.mockRestore();
      consoleSpy.error.mockRestore();
      consoleSpy.warn.mockRestore();
    });
  });
});
