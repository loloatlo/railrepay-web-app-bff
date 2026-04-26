/**
 * Unit Tests: web-app-bff infrastructure package wiring
 *
 * Story   : RAILREPAY-WEB-BFF-001
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates src/ with real implementation.
 * Failure reason: grep-based tests fail because src/ files don't import the packages yet.
 *                 Import-based tests fail because module does not exist.
 *
 * AC coverage map:
 *   AC-3   @railrepay/winston-logger is imported in src/ (not console.log)
 *   AC-4   @railrepay/metrics-pusher is imported in src/
 *   AC-4   @railrepay/redis-cache is imported in src/
 *   AC-10  All structured logs include component field 'web-app-bff/<area>'
 *   AC-10  Correlation ID propagated from X-Correlation-ID header; UUID generated when missing
 *
 * CLAUDE.md §8: Every service MUST USE (not just install) shared packages.
 * Jessie verifies via Phase 3.1 infrastructure wiring tests that assert actual package usage.
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-014 — TDD
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
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

vi.mock('ioredis', () => ({
  default: vi.fn(() => ({
    ping: vi.fn().mockResolvedValue('PONG'),
    quit: vi.fn().mockResolvedValue('OK'),
    on: vi.fn().mockReturnThis(),
  })),
}));

// ─── Service root path ─────────────────────────────────────────────────────────
const SERVICE_ROOT = path.resolve(
  new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  '../../../..'
);

/**
 * Recursively collect all .ts files under a directory (excluding node_modules / dist / tests).
 */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (['node_modules', 'dist', 'tests'].includes(entry)) continue;
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...collectTsFiles(fullPath));
    } else if (entry.endsWith('.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Check if any .ts file under src/ imports the given package name.
 */
function srcImportsPackage(packageName: string): boolean {
  const srcDir = path.join(SERVICE_ROOT, 'src');
  const files = collectTsFiles(srcDir);
  return files.some((filePath) => {
    try {
      const content = readFileSync(filePath, 'utf-8');
      return content.includes(`from '${packageName}'`) || content.includes(`from "${packageName}"`);
    } catch {
      return false;
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-001: infrastructure package wiring (unit)', () => {
  // ── AC-3: @railrepay/winston-logger import in src/ ────────────────────────

  describe('AC-3: @railrepay/winston-logger must be imported in src/ (not console.log)', () => {
    it('AC-3: at least one src/ file must import @railrepay/winston-logger', () => {
      // CLAUDE.md §8: Mandatory shared package usage.
      // This test fails in RED because src/ only contains the stub index.ts.
      expect(srcImportsPackage('@railrepay/winston-logger')).toBe(true);
    });
  });

  // ── AC-4: @railrepay/metrics-pusher import in src/ ────────────────────────

  describe('AC-4: @railrepay/metrics-pusher must be imported in src/', () => {
    it('AC-4: at least one src/ file must import @railrepay/metrics-pusher', () => {
      // AC-6 additionally specifies: use @railrepay/metrics-pusher, NOT prom-client directly.
      expect(srcImportsPackage('@railrepay/metrics-pusher')).toBe(true);
    });

    it('AC-6: src/ must NOT import directly from prom-client (use @railrepay/metrics-pusher instead)', () => {
      const srcDir = path.join(SERVICE_ROOT, 'src');
      const files = collectTsFiles(srcDir);
      const directPromClientImport = files.some((filePath) => {
        try {
          const content = readFileSync(filePath, 'utf-8');
          return (
            content.includes(`from 'prom-client'`) ||
            content.includes(`from "prom-client"`)
          );
        } catch {
          return false;
        }
      });
      expect(directPromClientImport).toBe(false);
    });
  });

  // ── AC-3/AC-4: @railrepay/redis-cache import in src/ ─────────────────────

  describe('AC-3/AC-4: @railrepay/redis-cache must be imported in src/', () => {
    it('AC-3: at least one src/ file must import @railrepay/redis-cache', () => {
      expect(srcImportsPackage('@railrepay/redis-cache')).toBe(true);
    });
  });

  // ── AC-10: Structured logs include component field ────────────────────────

  describe('AC-10: structured logs must include component:"web-app-bff/<area>" field', () => {
    it('AC-10: request logging middleware should call logger.info with component field', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createApp } = await import('../../../src/app.js');

      const mockRedis = {
        ping: vi.fn().mockResolvedValue('PONG'),
        quit: vi.fn().mockResolvedValue('OK'),
        on: vi.fn().mockReturnThis(),
      };

      const app = createApp(mockRedis);
      await request(app).get('/health');

      // At least one logger.info call must have a component field starting with 'web-app-bff/'
      const hasComponentField = sharedLogger.info.mock.calls.some(
        ([, meta]: [string, Record<string, unknown>]) =>
          meta &&
          typeof meta === 'object' &&
          typeof meta['component'] === 'string' &&
          (meta['component'] as string).startsWith('web-app-bff/')
      );
      expect(hasComponentField).toBe(true);
    });
  });

  // ── AC-10: Correlation ID propagation ────────────────────────────────────

  describe('AC-10: X-Correlation-ID header propagation', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('AC-10: request WITH X-Correlation-ID header should use provided value verbatim', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createApp } = await import('../../../src/app.js');

      const mockRedis = {
        ping: vi.fn().mockResolvedValue('PONG'),
        quit: vi.fn().mockResolvedValue('OK'),
        on: vi.fn().mockReturnThis(),
      };

      const app = createApp(mockRedis);
      const correlationId = 'test-correlation-id-12345';

      const res = await request(app)
        .get('/health')
        .set('X-Correlation-ID', correlationId);

      // The correlation ID should be echoed back in the response header
      expect(res.headers['x-correlation-id']).toBe(correlationId);
    });

    it('AC-10: request WITHOUT X-Correlation-ID header should generate a UUID v4', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createApp } = await import('../../../src/app.js');

      const mockRedis = {
        ping: vi.fn().mockResolvedValue('PONG'),
        quit: vi.fn().mockResolvedValue('OK'),
        on: vi.fn().mockReturnThis(),
      };

      const app = createApp(mockRedis);

      const res = await request(app).get('/health');

      // A UUID v4 should be generated and returned in the response header
      const generatedId = res.headers['x-correlation-id'];
      expect(generatedId).toBeDefined();
      // UUID v4 pattern: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      expect(generatedId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('AC-10: correlation ID should be logged in structured log output', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createApp } = await import('../../../src/app.js');

      const mockRedis = {
        ping: vi.fn().mockResolvedValue('PONG'),
        quit: vi.fn().mockResolvedValue('OK'),
        on: vi.fn().mockReturnThis(),
      };

      const app = createApp(mockRedis);
      const correlationId = 'wiring-test-correlation-99999';

      await request(app)
        .get('/health')
        .set('X-Correlation-ID', correlationId);

      // At least one logger call should contain the correlationId in its metadata
      const loggedCorrelationId = sharedLogger.info.mock.calls.some(
        ([, meta]: [string, Record<string, unknown>]) =>
          meta &&
          typeof meta === 'object' &&
          Object.values(meta).includes(correlationId)
      );
      expect(loggedCorrelationId).toBe(true);
    });
  });

  // ── AC-4: createApp() factory ──────────────────────────────────────────────

  describe('AC-4: createApp(redis) factory is exported from src/app.ts', () => {
    it('AC-4: src/app.ts should export createApp as a function', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const mod = await import('../../../src/app.js');
      expect(typeof mod.createApp).toBe('function');
    });

    it('AC-4: createApp() should set trust proxy to true', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createApp } = await import('../../../src/app.js');

      const mockRedis = {
        ping: vi.fn().mockResolvedValue('PONG'),
        quit: vi.fn().mockResolvedValue('OK'),
        on: vi.fn().mockReturnThis(),
      };

      const app = createApp(mockRedis);
      // Express stores 'trust proxy' setting — verify it is truthy
      expect(app.get('trust proxy')).toBeTruthy();
    });

    it('AC-4: createApp() should mount /health route', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createApp } = await import('../../../src/app.js');

      const mockRedis = {
        ping: vi.fn().mockResolvedValue('PONG'),
        quit: vi.fn().mockResolvedValue('OK'),
        on: vi.fn().mockReturnThis(),
      };

      const app = createApp(mockRedis);
      const res = await request(app).get('/health');

      // /health must exist — 404 is not acceptable
      expect(res.status).not.toBe(404);
    });

    it('AC-4: createApp() should mount /metrics route', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createApp } = await import('../../../src/app.js');

      const mockRedis = {
        ping: vi.fn().mockResolvedValue('PONG'),
        quit: vi.fn().mockResolvedValue('OK'),
        on: vi.fn().mockReturnThis(),
      };

      const app = createApp(mockRedis);
      const res = await request(app).get('/metrics');

      // /metrics must exist — 404 is not acceptable
      expect(res.status).not.toBe(404);
    });
  });
});
