/**
 * Scan Data Fixtures — web-app-bff WEB-BFF-004
 *
 * Fixtures for ticket upload + OCR orchestration endpoints.
 * Covers happy path, validation failures, boundary values, and edge cases.
 *
 * Story   : RAILREPAY-WEB-BFF-004
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-27
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these fixtures.
 *
 * OCR scan_id: UUID v4 from ocr service (POST /ocr/scan returns { scan_id })
 * Redis ownership key: bff:scan:<scanId> → user_id (90d TTL = 7776000 seconds)
 *
 * Mocked endpoints verified:
 *   POST {OCR_SERVICE_URL}/ocr/scan
 *   Verified real: services/ocr/src/handlers/scan.handler.ts createScanHandler
 *   Exposed at: services/ocr/src/index.ts mounted at /ocr/scan
 *   Last verified: 2026-04-27 (Jessie WEB-BFF-004 US-2)
 *
 *   GET {OCR_SERVICE_URL}/ocr/results/:scanId
 *   Verified real: services/ocr/src/handlers/results.handler.ts createResultsHandler
 *   Exposed at: services/ocr/src/index.ts mounted at /ocr/results/:scanId
 *   Last verified: 2026-04-27 (Jessie WEB-BFF-004 US-2)
 */

/** 90-day scan ownership TTL in seconds (AC-11: bff:scan:<scanId> Redis key) */
export const SCAN_OWNERSHIP_TTL_SECONDS = 7776000;

/** Build the Redis ownership key for a scan ID */
export function scanOwnershipRedisKey(scanId: string): string {
  return `bff:scan:${scanId}`;
}

/** UUID v4 regex for assertions */
export const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─── User + Session fixtures ─────────────────────────────────────────────────

/** Primary test user (owns the scan in user-scoping tests) */
export const PRIMARY_USER = {
  user_id: 'usr-00000004-aaaa-bbbb-cccc-000000000001',
  session_id: 'sid-00000004-aaaa-bbbb-cccc-000000000001',
  access_token: 'eyJhbGciOiJIUzI1NiJ9.fixture.primary-user-wef-004',
  refresh_at_iso: '2026-04-27T10:00:00.000Z',
  created_at_iso: '2026-04-27T10:00:00.000Z',
};

/** Second test user — used in AC-11 scoping (must get 403 on primary user's scan) */
export const SECOND_USER = {
  user_id: 'usr-00000004-dddd-eeee-ffff-000000000002',
  session_id: 'sid-00000004-dddd-eeee-ffff-000000000002',
  access_token: 'eyJhbGciOiJIUzI1NiJ9.fixture.second-user-wef-004',
  refresh_at_iso: '2026-04-27T10:00:00.000Z',
  created_at_iso: '2026-04-27T10:00:00.000Z',
};

// ─── Scan ID fixtures ────────────────────────────────────────────────────────

/** A valid UUID v4 scan_id returned by ocr service (happy path) */
export const HAPPY_SCAN_ID = '12345678-abcd-4abc-8abc-123456789012';

/** A second distinct scan_id for multi-scan boundary tests */
export const SECOND_SCAN_ID = '87654321-dcba-4bcd-9bcd-987654321098';

/** A malformed scan_id (contains invalid chars) — triggers AC-9 400 */
export const MALFORMED_SCAN_ID = 'not-a-valid-uuid-format';

/** A malformed scan_id (all numeric) — triggers AC-9 400 */
export const NUMERIC_SCAN_ID = '12345678901234567890';

// ─── Image buffer fixtures ───────────────────────────────────────────────────

/**
 * Minimal valid JPEG buffer (SOI marker + EOI marker = 4 bytes).
 * Realistic: JPEG always starts with FF D8 (SOI) and ends with FF D9 (EOI).
 * Used for happy-path upload tests (well under 10MB).
 */
export const MINIMAL_JPEG_BUFFER = Buffer.from([
  0xff, 0xd8, // SOI marker
  0xff, 0xe0, // APP0 marker
  0x00, 0x10, // APP0 length (16 bytes)
  0x4a, 0x46, 0x49, 0x46, 0x00, // JFIF\0
  0x01, 0x01, // version 1.1
  0x00,       // aspect ratio units (no units)
  0x00, 0x01, // X density = 1
  0x00, 0x01, // Y density = 1
  0x00, 0x00, // thumbnail size (0x0)
  0xff, 0xd9, // EOI marker
]);

/**
 * Minimal valid PNG buffer (PNG signature + IHDR chunk).
 * Realistic: PNG always starts with the 8-byte signature.
 * Used for happy-path upload tests with image/png content type.
 */
export const MINIMAL_PNG_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, // IHDR chunk length (13 bytes)
  0x49, 0x48, 0x44, 0x52, // IHDR
  0x00, 0x00, 0x00, 0x01, // width = 1
  0x00, 0x00, 0x00, 0x01, // height = 1
  0x08, 0x02,             // bit depth = 8, color type = 2 (RGB)
  0x00, 0x00, 0x00,       // compression, filter, interlace
  0x90, 0x77, 0x53, 0xde, // CRC
]);

/**
 * Oversized buffer exceeding the 10MB limit (10485761 bytes = 10MB + 1 byte).
 * Used for AC-4 (pre-stream 10MB rejection).
 * Note: This is 10,485,761 bytes to trigger busboy's limits.fileSize event.
 */
export const OVERSIZED_BUFFER = Buffer.alloc(10 * 1024 * 1024 + 1, 0x42); // 10MB + 1 byte

/** Maximum allowed buffer: exactly 10MB (should NOT be rejected) */
export const MAX_ALLOWED_BUFFER = Buffer.alloc(10 * 1024 * 1024, 0xff); // exactly 10MB

// ─── OCR service response fixtures ──────────────────────────────────────────

/** OCR scan submission success response (POST /ocr/scan → 200 { scan_id }) */
export const OCR_SCAN_RESPONSE = {
  scan_id: HAPPY_SCAN_ID,
};

/**
 * Full OCR results response (GET /ocr/results/:scanId → 200).
 * Shape matches results.handler.ts response (AC-10).
 */
export const OCR_RESULTS_RESPONSE = {
  scan_id: HAPPY_SCAN_ID,
  status: 'completed',
  confidence: 0.94,
  extracted_fields: {
    origin_station: 'London Paddington',
    destination_station: 'Bristol Temple Meads',
    origin_crs: 'PAD',
    destination_crs: 'BRI',
    travel_date: '2026-04-27',
    fare_pence: 8950,
    ticket_type: 'ANYTIME_RETURN',
    ticket_class: 'STANDARD',
    departure_time: '09:30',
    via_station: null,
    via_crs: null,
    operator_name: null,
    ticket_number: null,
  },
  raw_text: 'LONDON PADDINGTON\nBRISTOL TEMPLE MEADS\nANYTIME RETURN £89.50',
  claim_ready: true,
  ocr_status: 'completed',
  gcs_upload_status: 'uploaded',
  image_gcs_path: `gs://railrepay-tickets-prod/${PRIMARY_USER.user_id}/${HAPPY_SCAN_ID}.jpg`,
  error_message: null,
  created_at: '2026-04-27T10:00:00.000Z',
  updated_at: '2026-04-27T10:00:01.000Z',
};

/** OCR results response in 'processing' state (scan submitted but not yet complete) */
export const OCR_RESULTS_PROCESSING_RESPONSE = {
  scan_id: SECOND_SCAN_ID,
  status: 'processing',
  confidence: null,
  extracted_fields: null,
  raw_text: null,
  claim_ready: false,
  ocr_status: 'pending',
  gcs_upload_status: 'pending',
  image_gcs_path: null,
  error_message: null,
  created_at: '2026-04-27T10:00:00.000Z',
  updated_at: '2026-04-27T10:00:00.000Z',
};

// ─── MIME type fixtures ──────────────────────────────────────────────────────

/** Accepted MIME types (AC-5) */
export const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/png'] as const;

/** Rejected MIME types — should return 415 (AC-5) */
export const REJECTED_MIME_TYPES = [
  'application/pdf',    // explicitly excluded per OQ-C beta scope
  'image/heic',         // explicitly excluded per OQ-C beta scope
  'image/webp',         // not in scope
  'text/plain',         // clearly invalid
] as const;

// ─── source field fixtures ───────────────────────────────────────────────────

/** Valid source values (AC-7, OQ-B multipart text field) */
export const VALID_SOURCES = ['camera', 'screenshot', 'share', 'clipboard'] as const;

/**
 * Full OCR scan submission response (POST /ocr/scan → 200).
 * Shape matches scan.handler.ts:259-274 response (BL-280 fix — AC-2).
 * DISTINCT from OCR_RESULTS_RESPONSE (GET /ocr/results/:scanId) which
 * adds error_message, created_at, updated_at from the DB layer.
 */
export const FULL_OCR_UPLOAD_RESPONSE = {
  scan_id: HAPPY_SCAN_ID,
  status: 'completed' as const,
  confidence: 0.94,
  extracted_fields: {
    origin_station: 'London Paddington',
    destination_station: 'Bristol Temple Meads',
    origin_crs: 'PAD',
    destination_crs: 'BRI',
    travel_date: '2026-04-27',
    fare_pence: 8950,
    ticket_type: 'ANYTIME_RETURN',
    ticket_class: 'STANDARD',
    departure_time: '09:30',
    via_station: null,
    via_crs: null,
    operator_name: null,
    ticket_number: null,
  },
  raw_text: 'LONDON PADDINGTON\nBRISTOL TEMPLE MEADS\nANYTIME RETURN £89.50',
  missing_fields: ['operator_name', 'ticket_number'],
  claim_ready: true,
  ocr_status: 'completed' as const,
  gcs_upload_status: 'uploaded' as const,
  image_gcs_path: `gs://railrepay-tickets-prod/${PRIMARY_USER.user_id}/${HAPPY_SCAN_ID}.jpg`,
};
