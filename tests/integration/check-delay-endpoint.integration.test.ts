/**
 * Integration Tests: check-delay endpoint — POST /api/journeys/check-delay
 *
 * Story   : RAILREPAY-WEB-BFF-005
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-05-12
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/handlers/check-delay.handler.ts
 *   src/lib/journey-matcher-client.ts
 *   src/lib/delay-tracker-client.ts
 *   src/lib/eligibility-engine-client.ts
 *   src/routes/journeys.ts (mounts POST /api/journeys/check-delay)
 *
 * Failure reason: "Cannot find module" or 404 from routes not mounted.
 *
 * AC coverage map (integration focus per CLAUDE.md §7.1):
 *   AC-3:  Full chain matched + delayed → 200 flat composite (real Redis session)
 *   AC-6:  No-match path → 200 { matched: false } (real Redis; delay-tracker NOT called)
 *   AC-7:  Matched + delay-tracker 404 → 200 { status: 'pending' } (real Redis; eligibility-engine NOT called)
 *   AC-8:  Matched + delay-tracker OK + eligibility-engine 404 → 200 with delay data + pending_eligibility (real Redis)
 *
 * Infrastructure:
 *   - Testcontainers Redis (real I/O — no mock for session layer)
 *   - nock for all 3 upstream HTTP stubs
 *   - Real @railrepay/winston-logger (no vi.mock — infrastructure verification per CLAUDE.md §8)
 *   - supertest for HTTP
 *
 * AC-16 annotation (CLAUDE.md §8 shared package verification):
 *   NO vi.mock('@railrepay/winston-logger') in this file — real package imported
 *
 * Mocked HTTP endpoints (nock):
 *
 *   // Mocked: POST {JOURNEY_MATCHER_URL}/journeys/match
 *   // Verified real: services/journey-matcher/src/api/match-journey.handler.ts createMatchJourneyRouter
 *   // Exposed at: services/journey-matcher/src/index.ts app.use('/journeys', createMatchJourneyRouter(pool))
 *   // Last verified: 2026-05-12 (Jessie WEB-BFF-005 US-2)
 *
 *   // Mocked: GET {DELAY_TRACKER_URL}/delays/:journey_id?user_id=<uuid>
 *   // Verified real: services/delay-tracker/src/api/delay-query.handler.ts DelayQueryHandler.register()
 *   // Exposed at: services/delay-tracker/src/index.ts delayQueryHandler.register(app)
 *   // Last verified: 2026-05-12 (Jessie WEB-BFF-005 US-2)
 *
 *   // Mocked: GET {ELIGIBILITY_ENGINE_URL}/eligibility/:journey_id
 *   // Verified real: services/eligibility-engine/src/app.ts app.get('/eligibility/:journey_id')
 *   // Exposed at: services/eligibility-engine/src/index.ts via createApp()
 *   // Last verified: 2026-05-12 (Jessie WEB-BFF-005 US-2)
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §7 — Integration tests required
 *   CLAUDE.md §6.1 #10 — Mocked Endpoint Verification
 *   CLAUDE.md §8 — Mandatory shared package usage (real imports)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import nock from 'nock';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  VALID_CHECK_DELAY_BODY,
  VALID_CHECK_DELAY_BODY_RETURN,
  MATCHED_JOURNEY_ID,
  SECOND_JOURNEY_ID,
  JM_MATCH_RESPONSE_DELAYED,
  JM_MATCH_RESPONSE_ON_TIME,
  JM_NO_MATCH_RESPONSE,
  DT_DELAYED_RESPONSE,
  DT_ON_TIME_RESPONSE,
  DT_PENDING_RESPONSE,
  EE_ELIGIBLE_RESPONSE,
  EE_INELIGIBLE_RESPONSE,
  EE_NOT_FOUND_RESPONSE,
  CHECK_DELAY_USER,
  CORRELATION_ID_001,
  CORRELATION_ID_002,
} from '../fixtures/check-delay-data.js';

// ─── AC-16: Real shared packages — NO vi.mock for @railrepay/* in this file ───
// INTENTIONALLY not mocking @railrepay/winston-logger
// This integration test MUST exercise the real package implementations.

// ─── Stub base URLs ───────────────────────────────────────────────────────────
const JM_BASE = 'http://jm-integration-stub-bff005.test';
const DT_BASE = 'http://dt-integration-stub-bff005.test';
const EE_BASE = 'http://ee-integration-stub-bff005.test';

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-005: check-delay integration tests (Testcontainers Redis)', () => {
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
    process.env.JOURNEY_MATCHER_URL = JM_BASE;
    process.env.DELAY_TRACKER_URL = DT_BASE;
    process.env.ELIGIBILITY_ENGINE_URL = EE_BASE;
    process.env.SESSION_COOKIE_NAME = 'rr_session';
    process.env.JWT_SECRET = 'test-secret-32-chars-minimum-aaa';
    process.env.JWT_ISSUER = 'auth-service';
    process.env.JWT_AUDIENCE = 'web-app-bff';
    process.env.NODE_ENV = 'test';
    process.env.AUTH_SERVICE_URL = 'http://auth-service-integration-bff-005:9994';

    nock.cleanAll();

    // Build app — imports routes which import handlers and clients
    // @ts-expect-error — module does not exist yet (TDD RED phase)
    const { createJourneysRouter } = await import('../../src/routes/journeys.js');
    // @ts-expect-error — module does not exist yet (TDD RED phase)
    const { createCookieSessionMiddleware } = await import('../../src/middleware/cookie-session.js');
    // @ts-expect-error — module does not exist yet (TDD RED phase)
    const { createBearerFallbackMiddleware } = await import('../../src/middleware/bearer-fallback.js');

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(createCookieSessionMiddleware(redis));
    app.use(createBearerFallbackMiddleware());
    app.use(createJourneysRouter(redis));
  }, 120000);

  afterAll(async () => {
    nock.cleanAll();
    await redis.quit();
    await container.stop();
    delete process.env.JOURNEY_MATCHER_URL;
    delete process.env.DELAY_TRACKER_URL;
    delete process.env.ELIGIBILITY_ENGINE_URL;
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
  async function writeSession(user: typeof CHECK_DELAY_USER): Promise<void> {
    const sessionData = {
      user_id: user.user_id,
      session_id: user.session_id,
      access_token: user.access_token,
      refresh_at_iso: user.refresh_at_iso,
      created_at_iso: user.created_at_iso,
    };
    await redis.set(`bff:session:${user.session_id}`, JSON.stringify(sessionData), 'EX', 2592000);
  }

  // ─── AC-3: Full happy path — matched + delayed ────────────────────────────

  describe('AC-3: Full happy path — matched + delayed (real Redis session + nock 3 upstreams)', () => {
    it('AC-3: POST /api/journeys/check-delay → 200 flat composite with journey + delay + eligibility', async () => {
      await writeSession(CHECK_DELAY_USER);

      // Mocked: POST {JOURNEY_MATCHER_URL}/journeys/match
      // Verified real: services/journey-matcher/src/api/match-journey.handler.ts createMatchJourneyRouter
      // Exposed at: services/journey-matcher/src/index.ts mounted at /journeys
      // Last verified: 2026-05-12 (Jessie WEB-BFF-005 US-2)
      const jmScope = nock(JM_BASE)
        .post('/journeys/match')
        .reply(200, JM_MATCH_RESPONSE_DELAYED);

      // Mocked: GET {DELAY_TRACKER_URL}/delays/:journey_id?user_id=<uuid>
      // Verified real: services/delay-tracker/src/api/delay-query.handler.ts DelayQueryHandler
      // Exposed at: services/delay-tracker/src/index.ts delayQueryHandler.register(app)
      // Last verified: 2026-05-12 (Jessie WEB-BFF-005 US-2)
      const dtScope = nock(DT_BASE)
        .get(`/delays/${MATCHED_JOURNEY_ID}`)
        .query({ user_id: CHECK_DELAY_USER.user_id })
        .reply(200, DT_DELAYED_RESPONSE);

      // Mocked: GET {ELIGIBILITY_ENGINE_URL}/eligibility/:journey_id
      // Verified real: services/eligibility-engine/src/app.ts app.get('/eligibility/:journey_id')
      // Exposed at: services/eligibility-engine/src/index.ts via createApp()
      // Last verified: 2026-05-12 (Jessie WEB-BFF-005 US-2)
      const eeScope = nock(EE_BASE)
        .get(`/eligibility/${MATCHED_JOURNEY_ID}`)
        .reply(200, EE_ELIGIBLE_RESPONSE);

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('Cookie', `rr_session=${CHECK_DELAY_USER.session_id}`)
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      // AC-3: All three nock interceptors were called (verifies real HTTP clients)
      expect(jmScope.isDone()).toBe(true);
      expect(dtScope.isDone()).toBe(true);
      expect(eeScope.isDone()).toBe(true);

      expect(res.status).toBe(200);

      // AC-3: Flat composite shape
      expect(res.body.matched).toBe(true);
      expect(res.body.journey_id).toBe(MATCHED_JOURNEY_ID);
      expect(res.body.delay_minutes).toBe(23);
      expect(res.body.cancelled).toBe(false);
      expect(res.body.status).toBe('delayed');
      expect(res.body.eligible).toBe(true);
      expect(res.body.scheme).toBe('DR15');
      expect(res.body.compensation_pence).toBe(2238);
    });

    it('AC-3: user_id from session is forwarded to journey-matcher (not from request body)', async () => {
      await writeSession(CHECK_DELAY_USER);

      let capturedJmBody: Record<string, unknown> = {};

      // Mocked: POST {JOURNEY_MATCHER_URL}/journeys/match
      // Last verified: 2026-05-12 (Jessie WEB-BFF-005 US-2)
      nock(JM_BASE)
        .post('/journeys/match', (body: Record<string, unknown>) => {
          capturedJmBody = body;
          return true;
        })
        .reply(200, JM_MATCH_RESPONSE_DELAYED);

      nock(DT_BASE)
        .get(`/delays/${MATCHED_JOURNEY_ID}`)
        .query(true)
        .reply(200, DT_DELAYED_RESPONSE);

      nock(EE_BASE)
        .get(`/eligibility/${MATCHED_JOURNEY_ID}`)
        .reply(200, EE_ELIGIBLE_RESPONSE);

      await request(app)
        .post('/api/journeys/check-delay')
        .set('Cookie', `rr_session=${CHECK_DELAY_USER.session_id}`)
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY); // body does NOT contain user_id

      // Verify BFF injected user_id from session into journey-matcher call
      expect(capturedJmBody.user_id).toBe(CHECK_DELAY_USER.user_id);
    });
  });

  // ─── AC-6: No-match path ─────────────────────────────────────────────────

  describe('AC-6: No-match path — journey-matcher returns no_match (real Redis session)', () => {
    it('AC-6: should return 200 { matched: false } and NOT call delay-tracker or eligibility-engine', async () => {
      await writeSession(CHECK_DELAY_USER);

      // Mocked: POST {JOURNEY_MATCHER_URL}/journeys/match
      // Last verified: 2026-05-12 (Jessie WEB-BFF-005 US-2)
      const jmScope = nock(JM_BASE)
        .post('/journeys/match')
        .reply(200, JM_NO_MATCH_RESPONSE);

      // These scopes MUST NOT be consumed
      const dtScope = nock(DT_BASE)
        .get(/\/delays\/.*/)
        .query(true)
        .reply(200, DT_DELAYED_RESPONSE);

      const eeScope = nock(EE_BASE)
        .get(/\/eligibility\/.*/)
        .reply(200, EE_ELIGIBLE_RESPONSE);

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('Cookie', `rr_session=${CHECK_DELAY_USER.session_id}`)
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      expect(res.status).toBe(200);
      expect(res.body.matched).toBe(false);
      expect(res.body.journey_id).toBeNull();
      expect(res.body.reason).toBe('station_resolution_failed');

      // AC-6: journey-matcher was called, downstreams were NOT
      expect(jmScope.isDone()).toBe(true);
      expect(dtScope.isDone()).toBe(false); // NOT called
      expect(eeScope.isDone()).toBe(false); // NOT called
    });
  });

  // ─── AC-7: Eventual consistency — delay-tracker 404 ─────────────────────

  describe('AC-7: Eventual consistency — delay-tracker 404 after match (real Redis session)', () => {
    it('AC-7: should return 200 { status: "pending" } and NOT call eligibility-engine when delay-tracker returns 404', async () => {
      await writeSession(CHECK_DELAY_USER);

      // Mocked: POST {JOURNEY_MATCHER_URL}/journeys/match
      // Last verified: 2026-05-12 (Jessie WEB-BFF-005 US-2)
      const jmScope = nock(JM_BASE)
        .post('/journeys/match')
        .reply(200, JM_MATCH_RESPONSE_DELAYED);

      // Mocked: GET {DELAY_TRACKER_URL}/delays/:journey_id?user_id=<uuid>
      // Returning 404 — outbox race: journey-matcher wrote to outbox, delay-tracker not yet read it
      // Last verified: 2026-05-12 (Jessie WEB-BFF-005 US-2)
      const dtScope = nock(DT_BASE)
        .get(`/delays/${MATCHED_JOURNEY_ID}`)
        .query(true)
        .reply(404, { error: 'unknown_journey' });

      // This scope MUST NOT be consumed
      const eeScope = nock(EE_BASE)
        .get(/\/eligibility\/.*/)
        .reply(200, EE_ELIGIBLE_RESPONSE);

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('Cookie', `rr_session=${CHECK_DELAY_USER.session_id}`)
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      expect(res.status).toBe(200);
      expect(res.body.matched).toBe(true);
      expect(res.body.journey_id).toBe(MATCHED_JOURNEY_ID);
      expect(res.body.status).toBe('pending');
      expect(res.body.message).toBeDefined();

      // AC-7: journey-matcher + delay-tracker called, eligibility-engine NOT called
      expect(jmScope.isDone()).toBe(true);
      expect(dtScope.isDone()).toBe(true);
      expect(eeScope.isDone()).toBe(false); // AC-7 CRITICAL: NOT called
    });
  });

  // ─── AC-8: Eventual consistency — eligibility-engine 404 ────────────────

  describe('AC-8: Eventual consistency — eligibility-engine 404 after delay data received (real Redis)', () => {
    it('AC-8: should return 200 with delay data present and pending_eligibility when eligibility-engine returns 404', async () => {
      await writeSession(CHECK_DELAY_USER);

      // Mocked: POST {JOURNEY_MATCHER_URL}/journeys/match
      // Last verified: 2026-05-12 (Jessie WEB-BFF-005 US-2)
      const jmScope = nock(JM_BASE)
        .post('/journeys/match')
        .reply(200, JM_MATCH_RESPONSE_DELAYED);

      // Mocked: GET {DELAY_TRACKER_URL}/delays/:journey_id?user_id=<uuid>
      // Last verified: 2026-05-12 (Jessie WEB-BFF-005 US-2)
      const dtScope = nock(DT_BASE)
        .get(`/delays/${MATCHED_JOURNEY_ID}`)
        .query(true)
        .reply(200, DT_DELAYED_RESPONSE);

      // Mocked: GET {ELIGIBILITY_ENGINE_URL}/eligibility/:journey_id → 404
      // evaluation-coordinator hasn't run yet (eventual consistency)
      // Last verified: 2026-05-12 (Jessie WEB-BFF-005 US-2)
      const eeScope = nock(EE_BASE)
        .get(`/eligibility/${MATCHED_JOURNEY_ID}`)
        .reply(404, EE_NOT_FOUND_RESPONSE);

      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('Cookie', `rr_session=${CHECK_DELAY_USER.session_id}`)
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);

      expect(res.status).toBe(200);
      expect(res.body.matched).toBe(true);
      expect(res.body.journey_id).toBe(MATCHED_JOURNEY_ID);

      // AC-8: Delay data present (came from delay-tracker)
      expect(res.body.delay_minutes).toBe(23);
      expect(res.body.cancelled).toBe(false);

      // AC-8: Status signals pending eligibility
      expect(res.body.status).toMatch(/pending/);

      // AC-8: Eligibility fields absent (not evaluated yet)
      expect(res.body.eligible).toBeUndefined();
      expect(res.body.compensation_pence).toBeUndefined();

      // AC-8: All three upstreams were called
      expect(jmScope.isDone()).toBe(true);
      expect(dtScope.isDone()).toBe(true);
      expect(eeScope.isDone()).toBe(true);
    });
  });

  // ─── AC-2: Auth required (real Redis — no session) ────────────────────────

  describe('AC-2: Auth required — no session in real Redis', () => {
    it('AC-2: should return 401 { error: "unauthorized" } when no session in Redis', async () => {
      // No session written — Redis doesn't have this session
      const res = await request(app)
        .post('/api/journeys/check-delay')
        .set('x-correlation-id', CORRELATION_ID_001)
        .send(VALID_CHECK_DELAY_BODY);
        // No cookie set → no session → 401

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: 'unauthorized' });
    });
  });
});
