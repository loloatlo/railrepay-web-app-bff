/**
 * Unit Tests: web-app-bff GET /metrics endpoint
 *
 * Story   : RAILREPAY-WEB-BFF-001
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates src/routes/metrics.ts.
 * Failure reason: "Cannot find module '../../../src/routes/metrics.js'"
 *
 * AC coverage map:
 *   AC-6  GET /metrics returns Prometheus text format.
 *   AC-6  GET /metrics includes web_app_bff_up gauge set to 1.
 *   AC-6  GET /metrics exposes standard Node.js process metrics.
 *   AC-6  Uses @railrepay/metrics-pusher (not prom-client directly).
 *
 * ADR references:
 *   ADR-008 — Metrics endpoint pattern
 *   ADR-014 — TDD
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// @ts-expect-error — module does not exist yet (TDD RED phase)
import { createMetricsRouter } from '../../../src/routes/metrics.js';

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

// ─── metrics-pusher mock — intercept getRegistry() ────────────────────────────
// We simulate the registry so we can inject our own metrics output.
// This verifies createMetricsRouter() calls @railrepay/metrics-pusher's
// getRegistry() rather than reaching into prom-client directly.
const fakeRegistryOutput = [
  '# HELP web_app_bff_up BFF service availability gauge',
  '# TYPE web_app_bff_up gauge',
  'web_app_bff_up 1',
  '# HELP process_cpu_user_seconds_total Total user CPU time spent in seconds.',
  '# TYPE process_cpu_user_seconds_total counter',
  'process_cpu_user_seconds_total 0.1',
  '# HELP process_resident_memory_bytes Resident memory size in bytes.',
  '# TYPE process_resident_memory_bytes gauge',
  'process_resident_memory_bytes 52428800',
].join('\n');

const mockRegistry = {
  contentType: 'text/plain; version=0.0.4; charset=utf-8',
  metrics: vi.fn().mockResolvedValue(fakeRegistryOutput),
};

vi.mock('@railrepay/metrics-pusher', () => ({
  createMetricsRouter: vi.fn(), // mocked — test uses real createMetricsRouter from src/
  getRegistry: vi.fn(() => mockRegistry),
  resetRegistry: vi.fn(),
  Gauge: vi.fn().mockImplementation(() => ({ set: vi.fn() })),
  Counter: vi.fn().mockImplementation(() => ({ inc: vi.fn() })),
  Histogram: vi.fn().mockImplementation(() => ({ observe: vi.fn() })),
  Registry: vi.fn().mockImplementation(() => mockRegistry),
}));

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-001: GET /metrics (unit)', () => {
  let app: ReturnType<typeof express>;

  beforeEach(() => {
    app = express();
    // Mount the BFF metrics router under /metrics
    app.use('/metrics', createMetricsRouter());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── AC-6: Prometheus text format ────────────────────────────────────────────

  describe('AC-6: Prometheus text format', () => {
    it('AC-6: should return HTTP 200 from GET /metrics', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
    });

    it('AC-6: should return Content-Type with text/plain Prometheus format', async () => {
      const res = await request(app).get('/metrics');
      expect(res.headers['content-type']).toContain('text/plain');
    });

    it('AC-6: should return body containing # HELP markers (Prometheus text format)', async () => {
      const res = await request(app).get('/metrics');
      expect(res.text).toContain('# HELP');
    });

    it('AC-6: should return body containing # TYPE markers (Prometheus text format)', async () => {
      const res = await request(app).get('/metrics');
      expect(res.text).toContain('# TYPE');
    });
  });

  // ── AC-6: web_app_bff_up gauge present and set to 1 ─────────────────────────

  describe('AC-6: web_app_bff_up gauge', () => {
    it('AC-6: should include web_app_bff_up in metrics output', async () => {
      const res = await request(app).get('/metrics');
      expect(res.text).toContain('web_app_bff_up');
    });

    it('AC-6: web_app_bff_up gauge value should be 1 (service is healthy)', async () => {
      const res = await request(app).get('/metrics');
      // Matches "web_app_bff_up 1" or "web_app_bff_up{...} 1"
      expect(res.text).toMatch(/web_app_bff_up(?:\{[^}]*\})? 1/);
    });
  });

  // ── AC-6: Node.js process metrics present ───────────────────────────────────

  describe('AC-6: standard Node.js process metrics', () => {
    it('AC-6: should include process_cpu_user_seconds_total metric', async () => {
      const res = await request(app).get('/metrics');
      expect(res.text).toContain('process_cpu_user_seconds_total');
    });

    it('AC-6: should include process_resident_memory_bytes metric', async () => {
      const res = await request(app).get('/metrics');
      expect(res.text).toContain('process_resident_memory_bytes');
    });
  });

  // ── AC-6: Uses @railrepay/metrics-pusher (not prom-client directly) ─────────

  describe('AC-6: metrics router uses @railrepay/metrics-pusher getRegistry()', () => {
    it('AC-6: getRegistry() from @railrepay/metrics-pusher should be called when /metrics is hit', async () => {
      await request(app).get('/metrics');
      // The router must delegate to @railrepay/metrics-pusher's getRegistry() — not call prom-client directly
      expect(mockRegistry.metrics).toHaveBeenCalled();
    });
  });
});
