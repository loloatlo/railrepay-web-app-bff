/**
 * Handler: POST /api/tickets/upload
 *
 * Accepts a multipart/form-data request with an `image` file field.
 * Validates auth, MIME type, size limit (pre-stream busboy rejection),
 * converts image to base64, and proxies to OCR service.
 * Records scan ownership in Redis on success.
 *
 * Story   : RAILREPAY-WEB-BFF-004
 * AC-1    : 401 when no session
 * AC-2    : Accepts multipart/form-data with `image` field — 200 { scan_id, extracted_fields, raw_text, missing_fields, ... }
 * AC-3    : Missing `image` field → 400 { error: 'image field is required' }
 * AC-4    : Image >10MB → 413 { error: 'image too large', max_bytes: 10485760 } (pre-stream)
 * AC-5    : Unsupported MIME type → 415 { error: 'unsupported content_type', supported: [...] }
 * AC-6    : Forwards image to ocr via POST /ocr/scan with { image_base64, content_type, user_id, correlation_id, source? }
 * AC-7    : Optional multipart text field `source` forwarded; absent → not sent
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import busboy from 'busboy';
import { type Request, type Response } from 'express';
import { createLogger } from '@railrepay/winston-logger';
import type { Redis } from 'ioredis';
import type { RequestSession } from '../middleware/cookie-session.js';
import { submitScan } from '../lib/ocr-service-client.js';
import { recordScanOwnership } from '../lib/scan-ownership-store.js';

const logger = createLogger({
  serviceName: process.env.SERVICE_NAME ?? 'web-app-bff',
  level: process.env.LOG_LEVEL ?? 'info',
  environment: process.env.NODE_ENV ?? 'development',
});

/** Accepted MIME types for image upload (OQ-C lock: jpeg/png only) */
const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/png'] as const;

/** Maximum image size in bytes (OQ-F lock: 10 MB) */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10485760

/**
 * Create the upload-ticket handler, injecting redis.
 *
 * @param redis - ioredis client for scan ownership writes
 * @returns Express request handler
 */
export function createUploadTicketHandler(
  redis: Pick<Redis, 'set'>
) {
  return function uploadTicketHandler(req: Request, res: Response): void {
    const session = (req as Request & { session?: RequestSession }).session;

    // AC-1: Auth check
    if (!session) {
      logger.debug('uploadTicketHandler: no session — returning 401', {
        component: 'web-app-bff/upload-ticket-handler',
      });
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const correlationId = (req.headers['x-correlation-id'] as string | undefined)
      ?? `bff-${Date.now()}`;

    const contentTypeHeader = req.headers['content-type'] ?? '';

    // Check if it's multipart — if not, return 400
    if (!contentTypeHeader.includes('multipart/form-data')) {
      logger.debug('uploadTicketHandler: not multipart — returning 400', {
        component: 'web-app-bff/upload-ticket-handler',
      });
      res.status(400).json({ error: 'image field is required' });
      return;
    }

    // Parse multipart using busboy
    let bb: ReturnType<typeof busboy>;
    try {
      bb = busboy({
        headers: req.headers as Record<string, string | string[]>,
        limits: { fileSize: MAX_IMAGE_BYTES },
      });
    } catch {
      res.status(400).json({ error: 'image field is required' });
      return;
    }

    let imageBuffer: Buffer | null = null;
    let imageContentType: string | null = null;
    let source: string | undefined;
    let earlyError: { status: number; body: Record<string, unknown> } | null = null;
    let responseSent = false;

    function sendOnce(status: number, body: Record<string, unknown>): void {
      if (!responseSent) {
        responseSent = true;
        res.status(status).json(body);
      }
    }

    bb.on('file', (fieldname: string, file: NodeJS.ReadableStream, info: { filename: string; encoding: string; mimeType: string }) => {
      if (fieldname !== 'image') {
        // Drain the stream to prevent busboy from hanging
        file.resume();
        return;
      }

      const { mimeType } = info;
      const chunks: Buffer[] = [];

      // Validate MIME type (AC-5)
      if (!ACCEPTED_MIME_TYPES.includes(mimeType as typeof ACCEPTED_MIME_TYPES[number])) {
        logger.debug('uploadTicketHandler: unsupported MIME type', {
          component: 'web-app-bff/upload-ticket-handler',
          mimeType,
        });
        earlyError = {
          status: 415,
          body: { error: 'unsupported content_type', supported: ['image/jpeg', 'image/png'] },
        };
        // Drain the file stream
        file.resume();
        return;
      }

      imageContentType = mimeType;

      // AC-4: Pre-stream size limit via busboy limit event
      (file as NodeJS.EventEmitter).on('limit', () => {
        logger.debug('uploadTicketHandler: image size limit exceeded', {
          component: 'web-app-bff/upload-ticket-handler',
        });
        earlyError = {
          status: 413,
          body: { error: 'image too large', max_bytes: MAX_IMAGE_BYTES },
        };
        // Send response immediately (pre-stream rejection)
        sendOnce(413, { error: 'image too large', max_bytes: MAX_IMAGE_BYTES });
        // Unpipe to stop further data flow
        req.unpipe(bb);
      });

      file.on('data', (chunk: Buffer) => {
        if (earlyError === null) {
          chunks.push(chunk);
        }
      });

      file.on('close', () => {
        if (earlyError === null) {
          imageBuffer = Buffer.concat(chunks);
        }
      });
    });

    bb.on('field', (fieldname: string, value: string) => {
      if (fieldname === 'source') {
        source = value;
      }
    });

    bb.on('close', () => {
      // Handle early error that wasn't already sent (e.g. MIME type error)
      if (earlyError !== null) {
        sendOnce(earlyError.status, earlyError.body);
        return;
      }

      // AC-3: No image field provided
      if (imageBuffer === null || imageContentType === null) {
        logger.debug('uploadTicketHandler: image field missing', {
          component: 'web-app-bff/upload-ticket-handler',
        });
        sendOnce(400, { error: 'image field is required' });
        return;
      }

      const imageBase64 = imageBuffer.toString('base64');

      // AC-6: Forward to OCR service (async — handle in then/catch)
      submitScan({
        imageBase64,
        contentType: imageContentType,
        userId: session.user_id,
        correlationId,
        source,
      }).then(({ statusCode, body }) => {
        // AC-13: Map OCR errors
        if (statusCode >= 500) {
          logger.warn('uploadTicketHandler: ocr-service returned 5xx', {
            component: 'web-app-bff/upload-ticket-handler',
            statusCode,
          });
          sendOnce(503, { error: 'ocr_unavailable' });
          return;
        }

        if (statusCode !== 200) {
          logger.warn('uploadTicketHandler: ocr-service returned unexpected status', {
            component: 'web-app-bff/upload-ticket-handler',
            statusCode,
          });
          sendOnce(502, { error: 'ocr_error', upstream_status: statusCode });
          return;
        }

        // AC-2 (BL-280): forward full OCR response fields (not just scan_id).
        // The PWA confirm screen reads extracted_fields directly from this response;
        // stripping the OCR body caused confirm to show "No field data available."
        const ocrBody = body as Record<string, unknown>;
        const scanId = ocrBody.scan_id as string;

        const forwardedResponse = {
          scan_id: scanId,
          status: ocrBody.status,
          confidence: ocrBody.confidence,
          extracted_fields: ocrBody.extracted_fields,
          raw_text: ocrBody.raw_text,
          missing_fields: ocrBody.missing_fields,
          claim_ready: ocrBody.claim_ready,
          ocr_status: ocrBody.ocr_status,
          gcs_upload_status: ocrBody.gcs_upload_status,
          image_gcs_path: ocrBody.image_gcs_path,
        };

        recordScanOwnership(redis, scanId, session.user_id).then(() => {
          logger.info('uploadTicketHandler: scan submitted successfully', {
            component: 'web-app-bff/upload-ticket-handler',
          });
          sendOnce(200, forwardedResponse);
        }).catch((err: unknown) => {
          logger.warn('uploadTicketHandler: failed to record scan ownership', {
            component: 'web-app-bff/upload-ticket-handler',
            error: err instanceof Error ? err.message : String(err),
          });
          // Still return forwarded fields — ownership recording is best-effort for UX
          sendOnce(200, forwardedResponse);
        });
      }).catch((err: unknown) => {
        logger.warn('uploadTicketHandler: ocr-service call failed', {
          component: 'web-app-bff/upload-ticket-handler',
          error: err instanceof Error ? err.message : String(err),
        });
        sendOnce(503, { error: 'ocr_unavailable' });
      });
    });

    bb.on('error', (err: Error) => {
      // Suppress busboy internal errors (e.g. when stream ends early after req.unpipe)
      logger.debug('uploadTicketHandler: busboy error (suppressed)', {
        component: 'web-app-bff/upload-ticket-handler',
        error: err.message,
      });
      if (!responseSent) {
        sendOnce(400, { error: 'image field is required' });
      }
    });

    req.pipe(bb);
  };
}
