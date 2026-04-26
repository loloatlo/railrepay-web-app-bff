/**
 * Unit Tests: config/index.ts — WEB-BFF-002 additions
 *
 * Story   : RAILREPAY-WEB-BFF-002
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake extends src/config/index.ts.
 * Failure reason: Config returns a value that does NOT include the new fields,
 *                 OR missing/short JWT_SECRET does not throw.
 *
 * AC coverage map:
 *   AC-9: New env vars validated at getConfig():
 *         - JWT_SECRET: required, ≥32 chars; missing/short → fail-fast
 *         - JWT_ISSUER: default 'auth-service'
 *         - JWT_AUDIENCE: default 'web-app-bff'
 *         - SESSION_COOKIE_NAME: default 'rr_session'
 *         - SESSION_COOKIE_DOMAIN: optional; default unset → host-only
 *         - SESSION_COOKIE_SECURE: default true; false only for NODE_ENV=test/development
 *   AC-12: Coverage ≥80%/≥75% (enforced by Jessie in Phase 4 audit)
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

describe('RAILREPAY-WEB-BFF-002: config/index.ts — new env vars (unit)', () => {
  /** Valid baseline env for all tests (WEB-BFF-001 vars + new WEB-BFF-002 vars) */
  const validEnv: Record<string, string> = {
    PORT: '3000',
    REDIS_URL: 'redis://localhost:6379',
    AUTH_SERVICE_URL: 'http://localhost:9999',
    ALLOWED_ORIGINS: 'https://example.com',
    JWT_SECRET: 'exactly-32-chars-test-secret-aaa', // exactly 32 chars
  };

  beforeEach(() => {
    // Apply valid baseline
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

  // ─── AC-9: JWT_SECRET — required, ≥32 chars ────────────────────────────

  describe('AC-9: JWT_SECRET — required env var, ≥32 chars', () => {
    it('AC-9: should return config with jwtSecret when JWT_SECRET is set and ≥32 chars', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getConfig } = await import('../../../src/config/index.js');

      const config = getConfig();

      expect(config).toHaveProperty('jwtSecret');
      expect(config.jwtSecret).toBe(validEnv.JWT_SECRET);
    });

    it('AC-9: should throw when JWT_SECRET is missing', async () => {
      delete process.env.JWT_SECRET;

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getConfig } = await import('../../../src/config/index.js');

      expect(() => getConfig()).toThrow();
    });

    it('AC-9: should throw when JWT_SECRET is shorter than 32 chars', async () => {
      process.env.JWT_SECRET = 'too-short-secret'; // 16 chars

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getConfig } = await import('../../../src/config/index.js');

      expect(() => getConfig()).toThrow();
    });

    it('AC-9: should throw when JWT_SECRET is exactly 31 chars (boundary: <32 is invalid)', async () => {
      process.env.JWT_SECRET = 'a'.repeat(31); // 31 chars — invalid

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getConfig } = await import('../../../src/config/index.js');

      expect(() => getConfig()).toThrow();
    });

    it('AC-9: should NOT throw when JWT_SECRET is exactly 32 chars (boundary: ≥32 valid)', async () => {
      process.env.JWT_SECRET = 'a'.repeat(32); // exactly 32 chars — valid

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getConfig } = await import('../../../src/config/index.js');

      expect(() => getConfig()).not.toThrow();
    });
  });

  // ─── AC-9: JWT_ISSUER — defaults ────────────────────────────────────────

  describe('AC-9: JWT_ISSUER — optional, defaults to "auth-service"', () => {
    it('AC-9: should return jwtIssuer="auth-service" when JWT_ISSUER is not set', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getConfig } = await import('../../../src/config/index.js');

      const config = getConfig();

      expect(config.jwtIssuer).toBe('auth-service');
    });

    it('AC-9: should return custom jwtIssuer when JWT_ISSUER is set', async () => {
      process.env.JWT_ISSUER = 'custom-issuer';

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getConfig } = await import('../../../src/config/index.js');

      const config = getConfig();

      expect(config.jwtIssuer).toBe('custom-issuer');
    });
  });

  // ─── AC-9: JWT_AUDIENCE — defaults ─────────────────────────────────────

  describe('AC-9: JWT_AUDIENCE — optional, defaults to "web-app-bff"', () => {
    it('AC-9: should return jwtAudience="web-app-bff" when JWT_AUDIENCE is not set', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getConfig } = await import('../../../src/config/index.js');

      const config = getConfig();

      expect(config.jwtAudience).toBe('web-app-bff');
    });

    it('AC-9: should return custom jwtAudience when JWT_AUDIENCE env var is set', async () => {
      process.env.JWT_AUDIENCE = 'native-app';

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getConfig } = await import('../../../src/config/index.js');

      expect(getConfig().jwtAudience).toBe('native-app');
    });
  });

  // ─── AC-9: SESSION_COOKIE_NAME — defaults ───────────────────────────────

  describe('AC-9: SESSION_COOKIE_NAME — optional, defaults to "rr_session"', () => {
    it('AC-9: should return sessionCookieName="rr_session" when SESSION_COOKIE_NAME is not set', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getConfig } = await import('../../../src/config/index.js');

      expect(getConfig().sessionCookieName).toBe('rr_session');
    });

    it('AC-9: should return custom sessionCookieName when SESSION_COOKIE_NAME is set', async () => {
      process.env.SESSION_COOKIE_NAME = 'my_session';

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getConfig } = await import('../../../src/config/index.js');

      expect(getConfig().sessionCookieName).toBe('my_session');
    });
  });

  // ─── AC-9: SESSION_COOKIE_DOMAIN — optional, unset by default ──────────

  describe('AC-9: SESSION_COOKIE_DOMAIN — optional, unset → undefined (host-only)', () => {
    it('AC-9: should return sessionCookieDomain=undefined when SESSION_COOKIE_DOMAIN is not set', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getConfig } = await import('../../../src/config/index.js');

      const config = getConfig();

      expect(config.sessionCookieDomain).toBeUndefined();
    });

    it('AC-9: should return sessionCookieDomain when SESSION_COOKIE_DOMAIN is set', async () => {
      process.env.SESSION_COOKIE_DOMAIN = 'railrepay.co.uk';

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getConfig } = await import('../../../src/config/index.js');

      expect(getConfig().sessionCookieDomain).toBe('railrepay.co.uk');
    });
  });

  // ─── AC-9: SESSION_COOKIE_SECURE — defaults + NODE_ENV logic ───────────

  describe('AC-9: SESSION_COOKIE_SECURE — defaults true; false only in test/development', () => {
    it('AC-9: should return sessionCookieSecure=true when SESSION_COOKIE_SECURE is not set and NODE_ENV is production', async () => {
      process.env.NODE_ENV = 'production';

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getConfig } = await import('../../../src/config/index.js');

      expect(getConfig().sessionCookieSecure).toBe(true);
    });

    it('AC-9: should return sessionCookieSecure=false when NODE_ENV is test', async () => {
      process.env.NODE_ENV = 'test';

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getConfig } = await import('../../../src/config/index.js');

      expect(getConfig().sessionCookieSecure).toBe(false);
    });

    it('AC-9: should return sessionCookieSecure=false when NODE_ENV is development', async () => {
      process.env.NODE_ENV = 'development';

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getConfig } = await import('../../../src/config/index.js');

      expect(getConfig().sessionCookieSecure).toBe(false);
    });

    it('AC-9: should return sessionCookieSecure=true when SESSION_COOKIE_SECURE=true explicitly', async () => {
      process.env.SESSION_COOKIE_SECURE = 'true';
      process.env.NODE_ENV = 'test'; // normally false, but explicit env var overrides

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getConfig } = await import('../../../src/config/index.js');

      expect(getConfig().sessionCookieSecure).toBe(true);
    });
  });
});
