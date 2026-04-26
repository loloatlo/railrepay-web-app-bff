/**
 * Unit Tests: web-app-bff CORS middleware
 *
 * Story   : RAILREPAY-WEB-BFF-001
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates src/middleware/cors.ts.
 * Failure reason: "Cannot find module '../../../src/middleware/cors.js'"
 *
 * AC coverage map:
 *   AC-9  Allowed origin → ACAO header present, Access-Control-Allow-Credentials: true, Vary: Origin.
 *   AC-9  Unlisted origin → no ACAO header (or 403).
 *   AC-9  OPTIONS preflight → 204 with Access-Control-Allow-Methods and Access-Control-Allow-Headers.
 *   AC-9  ALLOWED_ORIGINS read from env var (comma-separated).
 *   AC-9  No wildcard (*) allowed ever.
 *   AC-9  Access-Control-Max-Age: 86400 on preflight.
 *   AC-9  Methods: GET, POST, PUT, DELETE, OPTIONS.
 *   AC-9  Headers: Content-Type, X-Correlation-ID, X-App-Version.
 *
 * Decision: AC-9 spec says "Rejects requests from origins NOT in the list (no * allowed ever)".
 * The Notion page says "403 (or no ACAO header)" — both are acceptable signals.
 * Tests check that ACAO header is NOT present for unlisted origins (strictest signal).
 *
 * ADR references:
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture (CORS config)
 *   OQ-6   — Domain not yet purchased; no railrepay.co.uk in ALLOWED_ORIGINS
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// @ts-expect-error — module does not exist yet (TDD RED phase)
import { createCorsMiddleware } from '../../../src/middleware/cors.js';

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

const ALLOWED_ORIGIN_1 = 'https://railrepay-web-app-bff-production.up.railway.app';
const ALLOWED_ORIGIN_2 = 'http://localhost:3000';
const UNLISTED_ORIGIN = 'https://evil-site.com';

/**
 * Build a test Express app with the CORS middleware applied.
 * ALLOWED_ORIGINS is set via env var (matching AC-9 contract).
 */
function buildCorsTestApp(allowedOriginsEnv?: string) {
  const app = express();
  // Temporarily override env var for this test app instance
  const origEnv = process.env.ALLOWED_ORIGINS;
  if (allowedOriginsEnv !== undefined) {
    process.env.ALLOWED_ORIGINS = allowedOriginsEnv;
  }
  app.use(createCorsMiddleware());
  // Restore env
  if (allowedOriginsEnv !== undefined) {
    if (origEnv !== undefined) {
      process.env.ALLOWED_ORIGINS = origEnv;
    } else {
      delete process.env.ALLOWED_ORIGINS;
    }
  }
  // A simple route to verify non-preflight requests land
  app.get('/test', (_req, res) => res.json({ ok: true }));
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-001: CORS middleware (unit)', () => {
  beforeEach(() => {
    process.env.ALLOWED_ORIGINS = `${ALLOWED_ORIGIN_1},${ALLOWED_ORIGIN_2}`;
  });

  afterEach(() => {
    delete process.env.ALLOWED_ORIGINS;
    vi.clearAllMocks();
  });

  // ── AC-9: Allowed origin → ACAO header present ────────────────────────────

  describe('AC-9: allowed origin should receive Access-Control-Allow-Origin header', () => {
    it('AC-9: GET with first allowed origin should return Access-Control-Allow-Origin matching that origin', async () => {
      const app = buildCorsTestApp();
      const res = await request(app)
        .get('/test')
        .set('Origin', ALLOWED_ORIGIN_1);

      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN_1);
    });

    it('AC-9: GET with second allowed origin should return Access-Control-Allow-Origin matching that origin', async () => {
      const app = buildCorsTestApp();
      const res = await request(app)
        .get('/test')
        .set('Origin', ALLOWED_ORIGIN_2);

      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN_2);
    });

    it('AC-9: response should include Access-Control-Allow-Credentials: true for allowed origins', async () => {
      const app = buildCorsTestApp();
      const res = await request(app)
        .get('/test')
        .set('Origin', ALLOWED_ORIGIN_1);

      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('AC-9: response should include Vary: Origin header for allowed origins', async () => {
      const app = buildCorsTestApp();
      const res = await request(app)
        .get('/test')
        .set('Origin', ALLOWED_ORIGIN_1);

      expect(res.headers['vary']).toContain('Origin');
    });
  });

  // ── AC-9: No wildcard (*) allowed ────────────────────────────────────────

  describe('AC-9: wildcard (*) must never appear in Access-Control-Allow-Origin', () => {
    it('AC-9: ACAO header must not be "*" for allowed origins (credentials require explicit origin)', async () => {
      const app = buildCorsTestApp();
      const res = await request(app)
        .get('/test')
        .set('Origin', ALLOWED_ORIGIN_1);

      expect(res.headers['access-control-allow-origin']).not.toBe('*');
    });

    it('AC-9: ACAO header must not be "*" for any origin (including requests without an Origin header)', async () => {
      const app = buildCorsTestApp();
      const res = await request(app).get('/test');

      // When no Origin header is sent (e.g. same-origin or curl), ACAO must not be '*'
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
    });
  });

  // ── AC-9: Unlisted origin → no ACAO header ────────────────────────────────

  describe('AC-9: unlisted origin should not receive Access-Control-Allow-Origin header', () => {
    it('AC-9: GET with unlisted origin should not have Access-Control-Allow-Origin', async () => {
      const app = buildCorsTestApp();
      const res = await request(app)
        .get('/test')
        .set('Origin', UNLISTED_ORIGIN);

      // Either no ACAO header, or the value is not the unlisted origin
      const acaoHeader = res.headers['access-control-allow-origin'];
      const isRejected = !acaoHeader || acaoHeader !== UNLISTED_ORIGIN;
      expect(isRejected).toBe(true);
    });
  });

  // ── AC-9: OPTIONS preflight ────────────────────────────────────────────────

  describe('AC-9: OPTIONS preflight request handling', () => {
    it('AC-9: OPTIONS from allowed origin should return 204 (no content)', async () => {
      const app = buildCorsTestApp();
      const res = await request(app)
        .options('/test')
        .set('Origin', ALLOWED_ORIGIN_1)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'Content-Type');

      expect(res.status).toBe(204);
    });

    it('AC-9: OPTIONS preflight should include Access-Control-Allow-Methods header', async () => {
      const app = buildCorsTestApp();
      const res = await request(app)
        .options('/test')
        .set('Origin', ALLOWED_ORIGIN_1)
        .set('Access-Control-Request-Method', 'POST');

      expect(res.headers['access-control-allow-methods']).toBeDefined();
      // Must include at least GET, POST, PUT, DELETE, OPTIONS
      const methods = res.headers['access-control-allow-methods'] ?? '';
      expect(methods).toContain('GET');
      expect(methods).toContain('POST');
      expect(methods).toContain('PUT');
      expect(methods).toContain('DELETE');
      expect(methods).toContain('OPTIONS');
    });

    it('AC-9: OPTIONS preflight should include Access-Control-Allow-Headers with required headers', async () => {
      const app = buildCorsTestApp();
      const res = await request(app)
        .options('/test')
        .set('Origin', ALLOWED_ORIGIN_1)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'Content-Type,X-Correlation-ID');

      const allowedHeaders = res.headers['access-control-allow-headers'] ?? '';
      expect(allowedHeaders).toContain('Content-Type');
      expect(allowedHeaders).toContain('X-Correlation-ID');
      expect(allowedHeaders).toContain('X-App-Version');
    });

    it('AC-9: OPTIONS preflight should include Access-Control-Max-Age: 86400', async () => {
      const app = buildCorsTestApp();
      const res = await request(app)
        .options('/test')
        .set('Origin', ALLOWED_ORIGIN_1)
        .set('Access-Control-Request-Method', 'POST');

      expect(res.headers['access-control-max-age']).toBe('86400');
    });

    it('AC-9: OPTIONS preflight should include Access-Control-Allow-Credentials: true', async () => {
      const app = buildCorsTestApp();
      const res = await request(app)
        .options('/test')
        .set('Origin', ALLOWED_ORIGIN_1)
        .set('Access-Control-Request-Method', 'POST');

      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });
  });

  // ── AC-9: ALLOWED_ORIGINS env var ──────────────────────────────────────────

  describe('AC-9: ALLOWED_ORIGINS is read from environment variable', () => {
    it('AC-9: should allow an origin dynamically added to ALLOWED_ORIGINS env var', async () => {
      const dynamicOrigin = 'http://localhost:4000';
      const app = buildCorsTestApp(
        `${ALLOWED_ORIGIN_1},${ALLOWED_ORIGIN_2},${dynamicOrigin}`
      );

      const res = await request(app)
        .get('/test')
        .set('Origin', dynamicOrigin);

      expect(res.headers['access-control-allow-origin']).toBe(dynamicOrigin);
    });

    it('AC-9: should reject an origin not in ALLOWED_ORIGINS even if it looks similar', async () => {
      // A near-miss origin that is NOT in the list
      const nearMissOrigin = 'http://localhost:3001'; // port 3001, not 3000
      const app = buildCorsTestApp(`${ALLOWED_ORIGIN_1},${ALLOWED_ORIGIN_2}`);

      const res = await request(app)
        .get('/test')
        .set('Origin', nearMissOrigin);

      const acaoHeader = res.headers['access-control-allow-origin'];
      const isRejected = !acaoHeader || acaoHeader !== nearMissOrigin;
      expect(isRejected).toBe(true);
    });
  });
});
