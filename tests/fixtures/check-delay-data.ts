/**
 * Check-Delay Fixtures — web-app-bff WEB-BFF-005
 *
 * Fixtures for the composite check-delay endpoint.
 * Covers happy paths, no-match, eventual-consistency races, and error scenarios.
 *
 * Story   : RAILREPAY-WEB-BFF-005
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-05-12
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these fixtures.
 *
 * Upstream contracts verified during code-walk (2026-05-12):
 *
 *   POST {JOURNEY_MATCHER_URL}/journeys/match
 *   Verified real: services/journey-matcher/src/api/match-journey.handler.ts createMatchJourneyRouter
 *   Exposed at: services/journey-matcher/src/index.ts app.use('/journeys', createMatchJourneyRouter(...))
 *   Matched response shape: { status: 'matched', journey_id, ... } | { status: 'no_match', reason, detail? }
 *   Last verified: 2026-05-12 (Jessie WEB-BFF-005 US-2)
 *
 *   GET {DELAY_TRACKER_URL}/delays/:journeyId?user_id=<uuid>
 *   Verified real: services/delay-tracker/src/api/delay-query.handler.ts DelayQueryHandler
 *   Exposed at: services/delay-tracker/src/index.ts delayQueryHandler.register(app) → app.get('/delays/:journeyId')
 *   Hit response shape: { journey_id, delay_minutes, cancelled, last_observed_at, status: 'delayed'|'cancelled'|'on_time' }
 *   Pending response shape: { journey_id, status: 'pending', message }
 *   Last verified: 2026-05-12 (Jessie WEB-BFF-005 US-2)
 *
 *   GET {ELIGIBILITY_ENGINE_URL}/eligibility/:journey_id
 *   Verified real: services/eligibility-engine/src/app.ts app.get('/eligibility/:journey_id')
 *   Exposed at: services/eligibility-engine/src/index.ts via createApp()
 *   Hit response shape: { journey_id, eligible, scheme, delay_minutes, compensation_percentage,
 *                         compensation_pence, ticket_fare_pence, reasons, applied_rules, evaluation_timestamp }
 *   Not-found response: { error: 'Evaluation not found', journey_id } → 404
 *   Last verified: 2026-05-12 (Jessie WEB-BFF-005 US-2)
 */

// ─── User + Session Fixtures ─────────────────────────────────────────────────

/** Primary test user for check-delay tests */
export const CHECK_DELAY_USER = {
  user_id: 'usr-00000005-aaaa-bbbb-cccc-000000000001',
  session_id: 'sid-00000005-aaaa-bbbb-cccc-000000000001',
  access_token: 'eyJhbGciOiJIUzI1NiJ9.fixture.check-delay-user-bff-005',
  refresh_at_iso: '2026-05-12T10:00:00.000Z',
  created_at_iso: '2026-05-12T10:00:00.000Z',
};

// ─── Journey UUIDs ───────────────────────────────────────────────────────────

/** UUID v4 returned by journey-matcher on successful match */
export const MATCHED_JOURNEY_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

/** A different journey_id used in secondary test scenarios */
export const SECOND_JOURNEY_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

// ─── Valid Request Bodies ────────────────────────────────────────────────────

/**
 * Valid minimal check-delay request body.
 * All required fields per the Zod schema that Blake will implement.
 * Mirrors journey-matcher's matchJourneySchema required fields
 * (the BFF forwards these to journey-matcher, stripping user_id from body).
 */
export const VALID_CHECK_DELAY_BODY = {
  origin_station: 'London Paddington',
  destination_station: 'Bristol Temple Meads',
  departure_date: '2026-05-12',
  departure_time: '09:30',
};

/** Alternate valid body with journey_type for boundary tests */
export const VALID_CHECK_DELAY_BODY_RETURN = {
  origin_station: 'Manchester Piccadilly',
  destination_station: 'Birmingham New Street',
  departure_date: '2026-05-13',
  departure_time: '14:15',
  journey_type: 'return' as const,
};

/** Body with optional scan_id field */
export const VALID_CHECK_DELAY_BODY_WITH_SCAN = {
  origin_station: 'Edinburgh Waverley',
  destination_station: 'Glasgow Central',
  departure_date: '2026-05-14',
  departure_time: '08:00',
  scan_id: 'cccccccc-3333-4333-8333-cccccccccccc',
};

// ─── Journey-Matcher Response Fixtures ──────────────────────────────────────

/**
 * journey-matcher matched response.
 * Shape from: services/journey-matcher/src/api/match-journey.handler.ts
 * Handler returns result of matcherService.matchJourney() which has status: 'matched'.
 */
export const JM_MATCH_RESPONSE_DELAYED = {
  status: 'matched' as const,
  journey_id: MATCHED_JOURNEY_ID,
  origin_station: 'London Paddington',
  destination_station: 'Bristol Temple Meads',
  departure_date: '2026-05-12',
  departure_time: '09:30',
  journey_type: 'single',
  idempotent_replay: false,
};

/** journey-matcher matched response for on_time scenario */
export const JM_MATCH_RESPONSE_ON_TIME = {
  status: 'matched' as const,
  journey_id: SECOND_JOURNEY_ID,
  origin_station: 'Manchester Piccadilly',
  destination_station: 'Birmingham New Street',
  departure_date: '2026-05-13',
  departure_time: '14:15',
  journey_type: 'return',
  idempotent_replay: false,
};

/**
 * journey-matcher no_match response.
 * Handler returns { status: 'no_match', reason, detail? }.
 */
export const JM_NO_MATCH_RESPONSE = {
  status: 'no_match' as const,
  reason: 'station_resolution_failed',
  detail: 'origin station "Unknown Station" could not be resolved to a GTFS stop',
};

/** journey-matcher no_match — route not found variant */
export const JM_NO_MATCH_RESPONSE_ROUTE = {
  status: 'no_match' as const,
  reason: 'no_route_found',
  detail: 'no route found between the specified stations at the given time',
};

// ─── Delay-Tracker Response Fixtures ────────────────────────────────────────

/**
 * delay-tracker hit response — delayed.
 * Shape from: services/delay-tracker/src/api/delay-query.handler.ts GetDelayHitResponse.
 * status: 'delayed', cancelled: false.
 */
export const DT_DELAYED_RESPONSE = {
  journey_id: MATCHED_JOURNEY_ID,
  delay_minutes: 23,
  cancelled: false,
  last_observed_at: '2026-05-12T11:00:00.000Z',
  status: 'delayed' as const,
};

/**
 * delay-tracker hit response — on_time.
 * status: 'on_time', delay_minutes: 0, cancelled: false.
 */
export const DT_ON_TIME_RESPONSE = {
  journey_id: SECOND_JOURNEY_ID,
  delay_minutes: 0,
  cancelled: false,
  last_observed_at: '2026-05-13T16:00:00.000Z',
  status: 'on_time' as const,
};

/**
 * delay-tracker hit response — cancelled.
 * status: 'cancelled', cancelled: true.
 */
export const DT_CANCELLED_RESPONSE = {
  journey_id: MATCHED_JOURNEY_ID,
  delay_minutes: 0,
  cancelled: true,
  last_observed_at: '2026-05-12T10:45:00.000Z',
  status: 'cancelled' as const,
};

/**
 * delay-tracker pending response — eventual consistency race.
 * Returned when journey is monitored but delay data not yet available.
 * Shape from: delay-query.handler.ts GetDelayPendingResponse.
 */
export const DT_PENDING_RESPONSE = {
  journey_id: MATCHED_JOURNEY_ID,
  status: 'pending' as const,
  message: 'no delay data yet',
};

// ─── Eligibility-Engine Response Fixtures ───────────────────────────────────

/**
 * eligibility-engine hit response — eligible.
 * Shape from: services/eligibility-engine/src/app.ts GET /eligibility/:journey_id.
 */
export const EE_ELIGIBLE_RESPONSE = {
  journey_id: MATCHED_JOURNEY_ID,
  eligible: true,
  scheme: 'DR15',
  delay_minutes: 23,
  compensation_percentage: 25,
  compensation_pence: 2238,
  ticket_fare_pence: 8950,
  reasons: ['Delay of 23 minutes qualifies for 25% refund under DR15 scheme'],
  applied_rules: ['DR15_15MIN_25PCT'],
  evaluation_timestamp: '2026-05-12T11:05:00.000Z',
};

/** eligibility-engine hit response — ineligible (delay too short) */
export const EE_INELIGIBLE_RESPONSE = {
  journey_id: SECOND_JOURNEY_ID,
  eligible: false,
  scheme: 'DR15',
  delay_minutes: 0,
  compensation_percentage: 0,
  compensation_pence: 0,
  ticket_fare_pence: 4500,
  reasons: ['Delay of 0 minutes does not meet DR15 15-minute threshold'],
  applied_rules: [],
  evaluation_timestamp: '2026-05-13T16:05:00.000Z',
};

/** eligibility-engine hit response for cancelled scenario */
export const EE_CANCELLED_ELIGIBLE_RESPONSE = {
  journey_id: MATCHED_JOURNEY_ID,
  eligible: true,
  scheme: 'DR15',
  delay_minutes: 120,
  compensation_percentage: 100,
  compensation_pence: 8950,
  ticket_fare_pence: 8950,
  reasons: ['Journey cancelled — 100% refund under DR15 scheme'],
  applied_rules: ['DR15_120MIN_100PCT'],
  evaluation_timestamp: '2026-05-12T11:00:00.000Z',
};

/**
 * eligibility-engine 404 response — eventual consistency race.
 * Shape from eligibility-engine/src/app.ts: { error: 'Evaluation not found', journey_id }
 */
export const EE_NOT_FOUND_RESPONSE = {
  error: 'Evaluation not found',
  journey_id: MATCHED_JOURNEY_ID,
};

// ─── Composite Response Shape ────────────────────────────────────────────────

/**
 * Expected flat composite response shape (OQ-5 lock: flat composite).
 * BFF merges journey_id, delay data, and eligibility data into one flat object.
 *
 * No-match shape (AC-6):
 *   { matched: false, journey_id: null, reason: string, detail?: string }
 *
 * Pending shape (AC-7):
 *   { matched: true, journey_id: string, status: 'pending', message: string }
 *
 * Pending-eligibility shape (AC-8):
 *   { matched: true, journey_id: string, delay_minutes, status: 'pending_eligibility', message }
 *
 * Full shape (AC-3, AC-4, AC-5):
 *   { matched: true, journey_id, delay_minutes, cancelled, last_observed_at, status,
 *     eligible, scheme, compensation_percentage, compensation_pence, ticket_fare_pence,
 *     reasons, applied_rules, evaluation_timestamp }
 */

// ─── Correlation IDs ─────────────────────────────────────────────────────────

export const CORRELATION_ID_001 = 'test-corr-bff005-0001';
export const CORRELATION_ID_002 = 'test-corr-bff005-0002';
export const CORRELATION_ID_003 = 'test-corr-bff005-0003';
export const CORRELATION_ID_004 = 'test-corr-bff005-0004';
