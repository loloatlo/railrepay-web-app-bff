/**
 * Unit Tests: config/index.ts — WEB-BFF-004 additions (OCR_SERVICE_URL)
 *
 * Story   : RAILREPAY-WEB-BFF-004
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-27
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake extends src/config/index.ts to include
 * OCR_SERVICE_URL validation.
 * Failure reason: getConfig() does not throw on missing OCR_SERVICE_URL,
 *                 OR config object has no ocrServiceUrl field.
 *
 * AC coverage map:
 *   AC-15: OCR_SERVICE_URL is read via config/index.ts at module load;
 *          missing/empty value throws Error on getConfig() call.
 *          Non-empty value → config.ocrServiceUrl is set.
 *
 * Extends: tests/unit/config/index.test.ts (WEB-BFF-002 tests untouched per Test Lock Rule)
 *
 * ADR references:
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

describe('RAILREPAY-WEB-BFF-004: config/index.ts — AC-15 OCR_SERVICE_URL (unit)', () => {
  /** Full valid baseline env including OCR_SERVICE_URL */
  const validEnv: Record<string, string> = {
    PORT: '3000',
    REDIS_URL: 'redis://localhost:6379',
    AUTH_SERVICE_URL: 'http://localhost:9999',
    ALLOWED_ORIGINS: 'https://example.com',
    JWT_SECRET: 'exactly-32-chars-test-secret-aaa',
    OCR_SERVICE_URL: 'http://ocr-stub.test',
  };

  beforeEach(() => {
    for (const [k, v] of Object.entries(validEnv)) {
      process.env[k] = v;
    }
    // Remove optional vars so defaults are tested cleanly
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    delete process.env.SESSION_COOKIE_NAME;
    delete process.env.SESSION_COOKIE_DOMAIN;
    delete process.env.SESSION_COOKIE_SECURE;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    for (const key of Object.keys(validEnv)) {
      delete process.env[key];
    }
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    delete process.env.SESSION_COOKIE_NAME;
    delete process.env.SESSION_COOKIE_DOMAIN;
    delete process.env.SESSION_COOKIE_SECURE;
    delete process.env.NODE_ENV;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  // ─── AC-15: OCR_SERVICE_URL — required, throws when missing ──────────────

  describe('AC-15: OCR_SERVICE_URL — required env var, throws on missing/empty', () => {
    it('AC-15: should return config with ocrServiceUrl when OCR_SERVICE_URL is set', async () => {
      // @ts-expect-error — ocrServiceUrl field does not exist yet (TDD RED phase)
      const { getConfig } = await import('../../../src/config/index.js');

      const config = getConfig();

      expect(config).toHaveProperty('ocrServiceUrl');
      expect(config.ocrServiceUrl).toBe('http://ocr-stub.test');
    });

    it('AC-15: should throw when OCR_SERVICE_URL is missing', async () => {
      delete process.env.OCR_SERVICE_URL;

      // @ts-expect-error — ocrServiceUrl field does not exist yet (TDD RED phase)
      const { getConfig } = await import('../../../src/config/index.js');

      expect(() => getConfig()).toThrow();
    });

    it('AC-15: should throw when OCR_SERVICE_URL is empty string', async () => {
      process.env.OCR_SERVICE_URL = '';

      // @ts-expect-error — ocrServiceUrl field does not exist yet (TDD RED phase)
      const { getConfig } = await import('../../../src/config/index.js');

      expect(() => getConfig()).toThrow();
    });

    it('AC-15: should NOT throw when OCR_SERVICE_URL is a Railway internal URL', async () => {
      process.env.OCR_SERVICE_URL = 'http://railrepay-ocr.railway.internal:3010';

      // @ts-expect-error — ocrServiceUrl field does not exist yet (TDD RED phase)
      const { getConfig } = await import('../../../src/config/index.js');

      expect(() => getConfig()).not.toThrow();
      const config = getConfig();
      expect(config.ocrServiceUrl).toBe('http://railrepay-ocr.railway.internal:3010');
    });

    it('AC-15: should NOT throw when all required vars including OCR_SERVICE_URL are set (regression)', async () => {
      // All required vars are set (validEnv baseline)
      // @ts-expect-error — ocrServiceUrl field does not exist yet (TDD RED phase)
      const { getConfig } = await import('../../../src/config/index.js');

      expect(() => getConfig()).not.toThrow();
    });
  });
});
