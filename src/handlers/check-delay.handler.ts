/**
 * Handler: POST /api/journeys/check-delay
 *
 * Composite endpoint that sequentially calls:
 *   1. journey-matcher  → POST /journeys/match  (5 s timeout)
 *   2. delay-tracker    → GET /delays/:id       (2 s timeout)
 *   3. eligibility-engine → GET /eligibility/:id (2 s timeout)
 *
 * Returns a flat composite response merging all three upstream responses.
 * Implements eventual-consistency semantics (pending / pending_eligibility).
 *
 * Story   : RAILREPAY-WEB-BFF-005
 * AC-1    : Body validation — 400 with Zod field-level details
 * AC-2    : No session → 401 { error: 'unauthorized' }
 * AC-3    : Happy path matched + delayed → 200 flat composite
 * AC-4    : Happy path matched + on_time → 200 flat composite
 * AC-5    : Happy path matched + cancelled → 200 flat composite
 * AC-6    : No-match → 200 { matched: false, journey_id: null, reason }
 * AC-7    : delay-tracker 404 → 200 { status: 'pending' }
 * AC-8    : eligibility-engine 404 → 200 with delay + status: 'pending_eligibility'
 * AC-9    : journey-matcher 503/timeout → 503 { error: 'upstream_unavailable', service: 'journey-matcher' }
 * AC-10   : delay-tracker 503/timeout → 503 { error: 'upstream_unavailable', service: 'delay-tracker' }
 * AC-11   : eligibility-engine 503/timeout → 503 { error: 'upstream_unavailable', service: 'eligibility-engine' }
 * AC-12   : delay-tracker 403 → 500
 * AC-14   : Structured log per request with outcome
 * AC-15   : Prometheus counter (web_app_bff_check_delay_total) + histogram
 *           (web_app_bff_check_delay_duration_seconds) updated per outcome
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { type RequestHandler, type Request, type Response } from 'express';
import { createLogger } from '@railrepay/winston-logger';
import { getRegistry, Counter, Histogram } from '@railrepay/metrics-pusher';
import { matchJourney } from '../lib/journey-matcher-client.js';
import { queryDelay } from '../lib/delay-tracker-client.js';
import { getEligibility } from '../lib/eligibility-engine-client.js';
import { triggerEvaluation } from '../lib/evaluation-coordinator-client.js';
import type { RequestSession } from '../middleware/cookie-session.js';

// ─── Logger (ADR-002 / CLAUDE.md §8) ─────────────────────────────────────────

const logger = createLogger({
  serviceName: process.env.SERVICE_NAME ?? 'web-app-bff',
  level: process.env.LOG_LEVEL ?? 'info',
  environment: process.env.NODE_ENV ?? 'development',
});

// ─── Metrics (AC-15 — metric names LOCKED per spec) ──────────────────────────
// Initialized lazily on first call so that test environments that mock
// @railrepay/metrics-pusher have the mock in place before initialization.
// Uses getRegistry() + Counter/Histogram — all real exports of @railrepay/metrics-pusher@1.1.1.

function getCounter(): Counter<string> {
  const existing = getRegistry().getSingleMetric('web_app_bff_check_delay_total');
  if (existing) return existing as Counter<string>;
  return new Counter({
    name: 'web_app_bff_check_delay_total',
    help: 'Total number of check-delay requests, labelled by outcome',
    labelNames: ['outcome'],
    registers: [getRegistry()],
  });
}

function getHistogram(): Histogram<string> {
  const existing = getRegistry().getSingleMetric('web_app_bff_check_delay_duration_seconds');
  if (existing) return existing as Histogram<string>;
  return new Histogram({
    name: 'web_app_bff_check_delay_duration_seconds',
    help: 'Duration of check-delay composite request in seconds',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [getRegistry()],
  });
}

// ─── Body validation (AC-1) ───────────────────────────────────────────────────

/** Validated check-delay request body shape */
interface CheckDelayBody {
  origin_station: string;
  destination_station: string;
  departure_date: string;
  departure_time: string;
  journey_type?: 'single' | 'return';
  scan_id?: string;
  // JM-002: Anytime/Any-Permitted ticket attestation fields (AC-7)
  ticket_type?: string;
  actual_departure_time?: string;
  actual_rid?: string;
}

/** Validation issue for a single field */
interface ValidationIssue {
  field: string;
  message: string;
}

/**
 * Validate the check-delay request body.
 * Returns null on success (body is valid), or an array of issues.
 */
function validateCheckDelayBody(raw: unknown): { data: CheckDelayBody } | { issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    issues.push({ field: '', message: 'request body must be a JSON object' });
    return { issues };
  }

  const obj = raw as Record<string, unknown>;

  // origin_station — required string
  if (typeof obj.origin_station !== 'string' || obj.origin_station.trim().length === 0) {
    issues.push({ field: 'origin_station', message: 'origin_station is required and must be a non-empty string' });
  }

  // destination_station — required string
  if (typeof obj.destination_station !== 'string' || obj.destination_station.trim().length === 0) {
    issues.push({ field: 'destination_station', message: 'destination_station is required and must be a non-empty string' });
  }

  // departure_date — required, YYYY-MM-DD format
  if (typeof obj.departure_date !== 'string' || obj.departure_date.trim().length === 0) {
    issues.push({ field: 'departure_date', message: 'departure_date is required and must be a string' });
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(obj.departure_date)) {
    issues.push({ field: 'departure_date', message: 'departure_date must be in YYYY-MM-DD format' });
  }

  // departure_time — required, HH:MM format
  if (typeof obj.departure_time !== 'string' || obj.departure_time.trim().length === 0) {
    issues.push({ field: 'departure_time', message: 'departure_time is required and must be a string' });
  } else if (!/^\d{2}:\d{2}$/.test(obj.departure_time)) {
    issues.push({ field: 'departure_time', message: 'departure_time must be in HH:MM format' });
  }

  // journey_type — optional enum
  if (obj.journey_type !== undefined) {
    if (obj.journey_type !== 'single' && obj.journey_type !== 'return') {
      issues.push({ field: 'journey_type', message: 'journey_type must be "single" or "return"' });
    }
  }

  if (issues.length > 0) {
    return { issues };
  }

  return {
    data: {
      origin_station: obj.origin_station as string,
      destination_station: obj.destination_station as string,
      departure_date: obj.departure_date as string,
      departure_time: obj.departure_time as string,
      ...(obj.journey_type !== undefined ? { journey_type: obj.journey_type as 'single' | 'return' } : {}),
      ...(obj.scan_id !== undefined ? { scan_id: obj.scan_id as string } : {}),
      // JM-002: Attestation fields — pass through when present (AC-7)
      ...(obj.ticket_type !== undefined ? { ticket_type: obj.ticket_type as string } : {}),
      ...(obj.actual_departure_time !== undefined ? { actual_departure_time: obj.actual_departure_time as string } : {}),
      ...(obj.actual_rid !== undefined ? { actual_rid: obj.actual_rid as string } : {}),
    },
  };
}

// ─── Handler factory ──────────────────────────────────────────────────────────

/**
 * Create the POST /api/journeys/check-delay request handler.
 *
 * Must be mounted AFTER cookie-session + bearer-fallback middleware so that
 * req.session is populated.
 *
 * @returns Express RequestHandler
 */
export function createCheckDelayHandler(): RequestHandler {
  return async function checkDelayHandler(
    req: Request,
    res: Response
  ): Promise<void> {
    const startMs = Date.now();
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) ?? crypto.randomUUID();

    // ── AC-2: Authentication ──────────────────────────────────────────────────
    const session = (req as Request & { session?: RequestSession }).session;

    if (!session?.user_id) {
      logger.info('check-delay: no session — returning 401', {
        component: 'web-app-bff/check-delay-handler',
        outcome: 'unauthorized',
        correlationId,
      });
      getCounter().inc({ outcome: 'unauthorized' });
      getHistogram().observe((Date.now() - startMs) / 1000);
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const userId = session.user_id;

    // ── AC-1: Body validation ─────────────────────────────────────────────────
    const validationResult = validateCheckDelayBody(req.body);

    if ('issues' in validationResult) {
      logger.info('check-delay: body validation failed', {
        component: 'web-app-bff/check-delay-handler',
        outcome: 'validation_error',
        correlationId,
      });
      getCounter().inc({ outcome: 'validation_error' });
      getHistogram().observe((Date.now() - startMs) / 1000);
      res.status(400).json({ error: 'validation_error', details: validationResult.issues });
      return;
    }

    const body = validationResult.data;

    // ── AC-3/4/5/6: Sequential 3-call orchestration ───────────────────────────

    // Step 1: journey-matcher (AC-6, AC-9)
    let jmResult: { statusCode: number; body: Record<string, unknown> };
    try {
      jmResult = await matchJourney(
        {
          user_id: userId,
          origin_station: body.origin_station,
          destination_station: body.destination_station,
          departure_date: body.departure_date,
          departure_time: body.departure_time,
          ...(body.journey_type !== undefined ? { journey_type: body.journey_type } : {}),
          ...(body.scan_id !== undefined ? { scan_id: body.scan_id } : {}),
          // JM-002: Forward attestation fields explicitly (AC-7 / ADR-027)
          // ticket_type from body wins; scan_id→OCR fallback is downstream JM concern.
          ...(body.ticket_type !== undefined ? { ticket_type: body.ticket_type } : {}),
          ...(body.actual_departure_time !== undefined ? { actual_departure_time: body.actual_departure_time } : {}),
          ...(body.actual_rid !== undefined ? { actual_rid: body.actual_rid } : {}),
        },
        correlationId
      );
    } catch {
      // Client should not throw — but handle defensively
      logger.warn('check-delay: journey-matcher threw unexpectedly', {
        component: 'web-app-bff/check-delay-handler',
        outcome: 'upstream_unavailable',
        service: 'journey-matcher',
        correlationId,
      });
      getCounter().inc({ outcome: 'upstream_unavailable' });
      getHistogram().observe((Date.now() - startMs) / 1000);
      res.status(503).json({ error: 'upstream_unavailable', service: 'journey-matcher' });
      return;
    }

    // AC-9: journey-matcher 5xx → 503
    if (jmResult.statusCode >= 500) {
      logger.warn('check-delay: journey-matcher returned 5xx', {
        component: 'web-app-bff/check-delay-handler',
        outcome: 'upstream_unavailable',
        service: 'journey-matcher',
        statusCode: jmResult.statusCode,
        correlationId,
      });
      getCounter().inc({ outcome: 'upstream_unavailable' });
      getHistogram().observe((Date.now() - startMs) / 1000);
      res.status(503).json({ error: 'upstream_unavailable', service: 'journey-matcher' });
      return;
    }

    // T2 Defect B secondary (BL-315): guard journey-matcher 4xx.
    // A 4xx from the matcher (e.g. actual_departure_time not HH:MM) must not fall through
    // to the candidates/no_match branches, which would dereference undefined journey_id
    // and call delay-tracker with undefined. Return 400 immediately.
    if (jmResult.statusCode >= 400 && jmResult.statusCode < 500) {
      logger.warn('check-delay: journey-matcher returned 4xx — validation error', {
        component: 'web-app-bff/check-delay-handler',
        outcome: 'matcher_validation_error',
        statusCode: jmResult.statusCode,
        correlationId,
      });
      getCounter().inc({ outcome: 'matcher_validation_error' });
      getHistogram().observe((Date.now() - startMs) / 1000);
      res.status(400).json({ error: 'validation_error', service: 'journey-matcher' });
      return;
    }

    // JM-002: candidates path — any-permitted no-attestation → pass through candidate list (AC-7)
    // Does NOT proceed to delay-tracker or eligibility-engine.
    if (jmResult.body.status === 'candidates') {
      logger.info('check-delay: journey-matcher returned candidates (anytime, no attestation)', {
        component: 'web-app-bff/check-delay-handler',
        outcome: 'candidates',
        correlationId,
      });
      getCounter().inc({ outcome: 'candidates' });
      getHistogram().observe((Date.now() - startMs) / 1000);
      res.status(200).json(jmResult.body);
      return;
    }

    // AC-6: no_match path — return 200 with matched=false, stop chain
    if (jmResult.body.status === 'no_match') {
      logger.info('check-delay: journey-matcher returned no_match', {
        component: 'web-app-bff/check-delay-handler',
        outcome: 'no_match',
        correlationId,
      });
      getCounter().inc({ outcome: 'no_match' });
      getHistogram().observe((Date.now() - startMs) / 1000);
      res.status(200).json({
        matched: false,
        journey_id: null,
        reason: jmResult.body.reason,
        ...(jmResult.body.detail !== undefined ? { detail: jmResult.body.detail } : {}),
      });
      return;
    }

    const journeyId = jmResult.body.journey_id as string;

    // Step 2: delay-tracker (AC-7, AC-10, AC-12)
    let dtResult: { statusCode: number; body: Record<string, unknown> };
    try {
      dtResult = await queryDelay(journeyId, userId, correlationId);
    } catch {
      logger.warn('check-delay: delay-tracker threw unexpectedly', {
        component: 'web-app-bff/check-delay-handler',
        outcome: 'upstream_unavailable',
        service: 'delay-tracker',
        correlationId,
      });
      getCounter().inc({ outcome: 'upstream_unavailable' });
      getHistogram().observe((Date.now() - startMs) / 1000);
      res.status(503).json({ error: 'upstream_unavailable', service: 'delay-tracker' });
      return;
    }

    // AC-10: delay-tracker 5xx → 503
    if (dtResult.statusCode >= 500) {
      logger.warn('check-delay: delay-tracker returned 5xx', {
        component: 'web-app-bff/check-delay-handler',
        outcome: 'upstream_unavailable',
        service: 'delay-tracker',
        statusCode: dtResult.statusCode,
        correlationId,
      });
      getCounter().inc({ outcome: 'upstream_unavailable' });
      getHistogram().observe((Date.now() - startMs) / 1000);
      res.status(503).json({ error: 'upstream_unavailable', service: 'delay-tracker' });
      return;
    }

    // AC-12: delay-tracker 403 → 500 (defense-in-depth; BFF supplies user_id from session)
    if (dtResult.statusCode === 403) {
      logger.error('check-delay: delay-tracker returned 403 (unexpected — user_id mismatch)', {
        component: 'web-app-bff/check-delay-handler',
        outcome: 'internal_error',
        correlationId,
      });
      getCounter().inc({ outcome: 'internal_error' });
      getHistogram().observe((Date.now() - startMs) / 1000);
      res.status(500).json({ error: 'internal_error', message: 'unexpected authorization error from upstream' });
      return;
    }

    // AC-7: delay-tracker 404 → 200 { status: 'pending' }, do NOT call eligibility-engine
    if (dtResult.statusCode === 404) {
      logger.info('check-delay: delay-tracker returned 404 (race — delay not yet available)', {
        component: 'web-app-bff/check-delay-handler',
        outcome: 'pending',
        correlationId,
      });
      getCounter().inc({ outcome: 'pending' });
      getHistogram().observe((Date.now() - startMs) / 1000);
      res.status(200).json({
        matched: true,
        journey_id: journeyId,
        status: 'pending',
        message: 'delay data not yet available — check back shortly',
      });
      return;
    }

    // Delay data available (200)
    const delayBody = dtResult.body;

    // Step 3: eligibility-engine (AC-8, AC-11)
    let eeResult: { statusCode: number; body: Record<string, unknown> };
    try {
      eeResult = await getEligibility(journeyId, correlationId);
    } catch {
      logger.warn('check-delay: eligibility-engine threw unexpectedly', {
        component: 'web-app-bff/check-delay-handler',
        outcome: 'upstream_unavailable',
        service: 'eligibility-engine',
        correlationId,
      });
      getCounter().inc({ outcome: 'upstream_unavailable' });
      getHistogram().observe((Date.now() - startMs) / 1000);
      res.status(503).json({ error: 'upstream_unavailable', service: 'eligibility-engine' });
      return;
    }

    // AC-11: eligibility-engine 5xx → 503
    if (eeResult.statusCode >= 500) {
      logger.warn('check-delay: eligibility-engine returned 5xx', {
        component: 'web-app-bff/check-delay-handler',
        outcome: 'upstream_unavailable',
        service: 'eligibility-engine',
        statusCode: eeResult.statusCode,
        correlationId,
      });
      getCounter().inc({ outcome: 'upstream_unavailable' });
      getHistogram().observe((Date.now() - startMs) / 1000);
      res.status(503).json({ error: 'upstream_unavailable', service: 'eligibility-engine' });
      return;
    }

    // AC-8: eligibility-engine 404 → return delay data + status: 'pending_eligibility'
    // BL-308 (ADR-028 Option A): fire-and-forget trigger to evaluation-coordinator
    // so the evaluation starts immediately rather than waiting for the Kafka event.
    // All trigger outcomes (202, 422, 5xx, network, missing env var) are NON-FATAL.
    //
    // BL-311 (ADR-029 Option A): forward delay_minutes + ticket_fare_pence + toc_code
    // so the coordinator can call evaluate() with real data (not UNKNOWN/0 defaults).
    if (eeResult.statusCode === 404) {
      const rawBody = req.body as Record<string, unknown>;
      // BL-313 AC-3: source toc_code from delayBody (delay-tracker response), NOT req.body.
      // The PWA does not send toc_code — it is only available from the delay-tracker response.
      const delayBodyTocCode = (delayBody as Record<string, unknown>).toc_code;
      const triggerPayload: { delay_minutes?: number; ticket_fare_pence?: number; toc_code?: string | null } = {
        delay_minutes: typeof delayBody.delay_minutes === 'number' ? delayBody.delay_minutes : undefined,
        ticket_fare_pence: typeof rawBody.ticket_fare_pence === 'number' ? rawBody.ticket_fare_pence : (typeof rawBody.fare_pence === 'number' ? rawBody.fare_pence : undefined),
        toc_code: (typeof delayBodyTocCode === 'string' || delayBodyTocCode === null) ? delayBodyTocCode : undefined,
      };
      Promise.resolve(triggerEvaluation(journeyId, correlationId, triggerPayload)).catch(() => {
        // non-fatal — poll will retry; coordinator errors must not affect the BFF response
      });
      logger.info('check-delay: eligibility-engine returned 404 (race — evaluation not yet run)', {
        component: 'web-app-bff/check-delay-handler',
        outcome: 'pending_eligibility',
        correlationId,
      });
      getCounter().inc({ outcome: 'pending_eligibility' });
      getHistogram().observe((Date.now() - startMs) / 1000);
      res.status(200).json({
        matched: true,
        journey_id: journeyId,
        delay_minutes: delayBody.delay_minutes,
        cancelled: delayBody.cancelled,
        last_observed_at: delayBody.last_observed_at,
        status: 'pending_eligibility',
        message: 'eligibility evaluation not yet available — check back shortly',
      });
      return;
    }

    // AC-3/4/5: Full composite — all three upstreams succeeded
    const eeBody = eeResult.body;
    const delayStatus = delayBody.status as string;

    logger.info('check-delay: full composite response assembled', {
      component: 'web-app-bff/check-delay-handler',
      outcome: delayStatus,
      correlationId,
    });
    getCounter().inc({ outcome: delayStatus });
    getHistogram().observe((Date.now() - startMs) / 1000);

    res.status(200).json({
      matched: true,
      journey_id: journeyId,
      // Delay data
      delay_minutes: delayBody.delay_minutes,
      cancelled: delayBody.cancelled,
      last_observed_at: delayBody.last_observed_at,
      status: delayStatus,
      // Eligibility data
      eligible: eeBody.eligible,
      scheme: eeBody.scheme,
      compensation_percentage: eeBody.compensation_percentage,
      compensation_pence: eeBody.compensation_pence,
      ticket_fare_pence: eeBody.ticket_fare_pence,
      reasons: eeBody.reasons,
      applied_rules: eeBody.applied_rules,
      evaluation_timestamp: eeBody.evaluation_timestamp,
    });
  };
}
