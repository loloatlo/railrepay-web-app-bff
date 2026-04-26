/**
 * Unit Tests: requireSameOrigin middleware (CSRF origin check)
 *
 * Story   : RAILREPAY-WEB-BFF-002
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates src/middleware/require-same-origin.ts.
 * Failure reason: "Cannot find module '../../src/middleware/require-same-origin.js'"
 *
 * AC coverage map:
 *   AC-6: requireSameOrigin middleware:
 *         - POST/PUT/PATCH/DELETE with Origin NOT in ALLOWED_ORIGINS → 403 {error:'origin_forbidden'}
 *         - POST/PUT/PATCH/DELETE with Origin absent → pass through (next())
 *         - GET/HEAD/OPTIONS always bypass (no origin check)
 *         - POST/PUT/PATCH/DELETE with Origin IN ALLOWED_ORIGINS → pass through
 *
 * ADR references:
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture
 *   OQ-3   — CSRF: SameSite=Lax + strict origin check on state-changing routes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';

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

// ─── Test origin constants ────────────────────────────────────────────────────
const ALLOWED_ORIGIN = 'https://railrepay-web-app-bff-production.up.railway.app';
const LOCAL_ORIGIN = 'http://localhost:3000';
const FORBIDDEN_ORIGIN = 'https://evil-attacker.com';

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-002: requireSameOrigin middleware (unit)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ALLOWED_ORIGINS = `${ALLOWED_ORIGIN},${LOCAL_ORIGIN}`;
  });

  afterEach(() => {
    delete process.env.ALLOWED_ORIGINS;
    vi.restoreAllMocks();
  });

  // ─── AC-6: Forbidden origin on state-changing methods ───────────────────

  describe('AC-6: POST/PUT/PATCH/DELETE with unlisted Origin → 403', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      it(`AC-6: ${method} with forbidden Origin should return 403 {error:'origin_forbidden'}`, async () => {
        // @ts-expect-error — module does not exist yet (TDD RED phase)
        const { createRequireSameOriginMiddleware } = await import('../../src/middleware/require-same-origin.js');

        const app = express();
        app.use(createRequireSameOriginMiddleware());
        app[method.toLowerCase() as 'post']('/test', (_req, res) => res.json({ ok: true }));

        const res = await (request(app) as Record<string, CallableFunction>)[method.toLowerCase()]('/test')
          .set('Origin', FORBIDDEN_ORIGIN);

        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'origin_forbidden' });
      });
    }
  });

  // ─── AC-6: Absent Origin on state-changing methods → pass through ────────

  describe('AC-6: POST/PUT/PATCH/DELETE without Origin header → pass through', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      it(`AC-6: ${method} without Origin header should call next() (server-to-server allowed)`, async () => {
        // @ts-expect-error — module does not exist yet (TDD RED phase)
        const { createRequireSameOriginMiddleware } = await import('../../src/middleware/require-same-origin.js');

        const app = express();
        app.use(createRequireSameOriginMiddleware());
        app[method.toLowerCase() as 'post']('/test', (_req, res) => res.json({ ok: true }));

        const res = await (request(app) as Record<string, CallableFunction>)[method.toLowerCase()]('/test');

        expect(res.status).toBe(200);
      });
    }
  });

  // ─── AC-6: Allowed origin on state-changing methods → pass through ───────

  describe('AC-6: POST/PUT/PATCH/DELETE with allowed Origin → pass through', () => {
    it('AC-6: POST with listed ALLOWED_ORIGIN should call next()', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createRequireSameOriginMiddleware } = await import('../../src/middleware/require-same-origin.js');

      const app = express();
      app.use(createRequireSameOriginMiddleware());
      app.post('/test', (_req, res) => res.json({ ok: true }));

      const res = await request(app)
        .post('/test')
        .set('Origin', ALLOWED_ORIGIN);

      expect(res.status).toBe(200);
    });

    it('AC-6: DELETE with localhost origin (ALLOWED_ORIGINS includes localhost) should pass through', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createRequireSameOriginMiddleware } = await import('../../src/middleware/require-same-origin.js');

      const app = express();
      app.use(createRequireSameOriginMiddleware());
      app.delete('/test', (_req, res) => res.json({ ok: true }));

      const res = await request(app)
        .delete('/test')
        .set('Origin', LOCAL_ORIGIN);

      expect(res.status).toBe(200);
    });
  });

  // ─── AC-6: GET/HEAD/OPTIONS always bypass ────────────────────────────────

  describe('AC-6: GET/HEAD/OPTIONS bypass origin check entirely', () => {
    it('AC-6: GET with forbidden origin should NOT return 403 (bypass)', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createRequireSameOriginMiddleware } = await import('../../src/middleware/require-same-origin.js');

      const app = express();
      app.use(createRequireSameOriginMiddleware());
      app.get('/test', (_req, res) => res.json({ ok: true }));

      const res = await request(app)
        .get('/test')
        .set('Origin', FORBIDDEN_ORIGIN);

      // GET bypasses — should NOT be 403
      expect(res.status).not.toBe(403);
    });

    it('AC-6: OPTIONS with forbidden origin should bypass (preflight handled by CORS middleware)', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createRequireSameOriginMiddleware } = await import('../../src/middleware/require-same-origin.js');

      const app = express();
      app.use(createRequireSameOriginMiddleware());
      app.options('/test', (_req, res) => res.status(204).end());

      const res = await request(app)
        .options('/test')
        .set('Origin', FORBIDDEN_ORIGIN);

      // OPTIONS must NOT be blocked by this middleware
      expect(res.status).not.toBe(403);
    });
  });

  // ─── AC-6: ALLOWED_ORIGINS read from env var ─────────────────────────────

  describe('AC-6: reads ALLOWED_ORIGINS from environment variable at creation time', () => {
    it('AC-6: POST with origin that is in the dynamically configured ALLOWED_ORIGINS should pass', async () => {
      const dynamicOrigin = 'http://localhost:4000';
      process.env.ALLOWED_ORIGINS = `${ALLOWED_ORIGIN},${dynamicOrigin}`;

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createRequireSameOriginMiddleware } = await import('../../src/middleware/require-same-origin.js');

      const app = express();
      app.use(createRequireSameOriginMiddleware());
      app.post('/test', (_req, res) => res.json({ ok: true }));

      const res = await request(app)
        .post('/test')
        .set('Origin', dynamicOrigin);

      expect(res.status).toBe(200);
    });
  });
});
