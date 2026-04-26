/**
 * Unit Tests: web-app-bff startup, config validation, and graceful shutdown
 *
 * Story   : RAILREPAY-WEB-BFF-001
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates src/index.ts with real implementation.
 * Failure reason: "Cannot find module '../../../src/index.js'" or named exports absent.
 *
 * AC coverage map:
 *   AC-1   package.json declares all required deps (covered in deployment-artifacts.test.ts)
 *   AC-3   startServer() exists and can boot without error when valid env vars are set.
 *   AC-3   shutdown(signal, server, redis) closes HTTP server then Redis client.
 *   AC-3   Auto-start guard: startServer() NOT called automatically when imported (not argv[1]).
 *   AC-3   Logs "web-app-bff started" via @railrepay/winston-logger on listen.
 *   AC-12  Service exits non-zero (or throws) when REDIS_URL env var is missing.
 *   AC-12  Service exits non-zero (or throws) when AUTH_SERVICE_URL env var is missing.
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-014 — TDD
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';

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

// ─── ioredis mock ──────────────────────────────────────────────────────────────
// We mock ioredis so unit tests don't try to connect to real Redis.
const mockRedisInstance = {
  ping: vi.fn().mockResolvedValue('PONG'),
  quit: vi.fn().mockResolvedValue('OK'),
  on: vi.fn().mockReturnThis(),
  disconnect: vi.fn(),
};
vi.mock('ioredis', () => ({
  default: vi.fn(() => mockRedisInstance),
  Redis: vi.fn(() => mockRedisInstance),
}));

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-001: startup + graceful shutdown (unit)', () => {
  const requiredEnv = {
    PORT: '3001',
    REDIS_URL: 'redis://localhost:6379',
    AUTH_SERVICE_URL: 'http://auth-stub:9999',
    ALLOWED_ORIGINS: 'https://railrepay-web-app-bff-production.up.railway.app,http://localhost:3000',
  };

  beforeEach(() => {
    // Set valid env vars for tests that need them
    Object.assign(process.env, requiredEnv);
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up env vars
    for (const key of Object.keys(requiredEnv)) {
      delete process.env[key];
    }
  });

  // ── AC-3: startServer() exports ───────────────────────────────────────────

  describe('AC-3: module exports', () => {
    it('AC-3: src/index.ts should export startServer as a function', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const mod = await import('../../../src/index.js');
      expect(typeof mod.startServer).toBe('function');
    });

    it('AC-3: src/index.ts should export shutdown as a function', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const mod = await import('../../../src/index.js');
      expect(typeof mod.shutdown).toBe('function');
    });

    it('AC-3: src/index.ts should export app (may be null until startServer called)', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const mod = await import('../../../src/index.js');
      // app is exported — initial value can be null (not yet started) or an Express instance
      expect('app' in mod).toBe(true);
    });
  });

  // ── AC-3: startServer() boots and logs ────────────────────────────────────

  describe('AC-3: startServer() boots server and logs startup message', () => {
    it('AC-3: startServer({ skipDependencyCheck: true }) should resolve without throwing', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { startServer, shutdown } = await import('../../../src/index.js');

      let server: http.Server | undefined;
      let redis: { quit: () => Promise<unknown> } | undefined;

      // startServer should resolve — pass skipDependencyCheck so it doesn't try to contact auth-service
      await expect(
        startServer({ skipDependencyCheck: true }).then((result: { server: http.Server; redis: typeof redis }) => {
          server = result?.server;
          redis = result?.redis;
        })
      ).resolves.toBeUndefined();

      // Cleanup — close server and redis if returned
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      if (redis) {
        await redis.quit();
      }
    }, 10000);

    it('AC-3: should log "web-app-bff started" via @railrepay/winston-logger on listen', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { startServer, shutdown } = await import('../../../src/index.js');

      let server: http.Server | undefined;
      let redis: { quit: () => Promise<unknown> } | undefined;

      await startServer({ skipDependencyCheck: true }).then((result: { server: http.Server; redis: typeof redis }) => {
        server = result?.server;
        redis = result?.redis;
      }).catch(() => {
        // If startServer throws (expected in RED), the log check below will simply fail
      });

      // "web-app-bff started" must appear in logger.info calls
      const infoCalls: Array<[string, ...unknown[]]> = sharedLogger.info.mock.calls;
      const startedLog = infoCalls.find(([msg]) =>
        typeof msg === 'string' && msg.includes('web-app-bff started')
      );
      expect(startedLog).toBeDefined();

      // Cleanup
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      if (redis) {
        await redis.quit();
      }
    }, 10000);

    it('AC-3: startup log should include component field "web-app-bff/server"', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { startServer } = await import('../../../src/index.js');

      let server: http.Server | undefined;
      let redis: { quit: () => Promise<unknown> } | undefined;

      await startServer({ skipDependencyCheck: true }).then((result: { server: http.Server; redis: typeof redis }) => {
        server = result?.server;
        redis = result?.redis;
      }).catch(() => {});

      // Find the call that has component 'web-app-bff/server'
      const infoCallsWithComponent = sharedLogger.info.mock.calls.filter(
        ([, meta]: [string, Record<string, unknown>]) =>
          meta && typeof meta === 'object' && meta['component'] === 'web-app-bff/server'
      );
      expect(infoCallsWithComponent.length).toBeGreaterThan(0);

      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      if (redis) {
        await redis.quit();
      }
    }, 10000);
  });

  // ── AC-3: shutdown() order — HTTP server closes before Redis ───────────────

  describe('AC-3: shutdown() closes HTTP server then Redis client (in that order)', () => {
    it('AC-3: shutdown() should call server.close() before redis.quit()', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { shutdown } = await import('../../../src/index.js');

      const closeOrder: string[] = [];

      const mockServer = {
        close: vi.fn((cb: () => void) => {
          closeOrder.push('server.close');
          cb();
        }),
      } as unknown as http.Server;

      const mockRedis = {
        quit: vi.fn().mockImplementation(async () => {
          closeOrder.push('redis.quit');
          return 'OK';
        }),
      };

      await shutdown('SIGTERM', mockServer, mockRedis);

      expect(closeOrder[0]).toBe('server.close');
      expect(closeOrder[1]).toBe('redis.quit');
    });

    it('AC-3: shutdown() should log the received signal', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { shutdown } = await import('../../../src/index.js');

      const mockServer = {
        close: vi.fn((cb: () => void) => cb()),
      } as unknown as http.Server;
      const mockRedis = { quit: vi.fn().mockResolvedValue('OK') };

      await shutdown('SIGTERM', mockServer, mockRedis);

      const loggedMessages: string[] = sharedLogger.info.mock.calls.map(
        ([msg]: [string]) => msg
      );
      const hasSignalLog = loggedMessages.some((msg) => msg.includes('SIGTERM'));
      expect(hasSignalLog).toBe(true);
    });
  });

  // ── AC-12: Config validation — missing REDIS_URL ──────────────────────────

  describe('AC-12: missing REDIS_URL should cause startup failure', () => {
    it('AC-12: startServer() should throw or reject when REDIS_URL is missing', async () => {
      delete process.env.REDIS_URL;

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { startServer } = await import('../../../src/index.js');

      await expect(startServer()).rejects.toThrow();
    });
  });

  // ── AC-12: Config validation — missing AUTH_SERVICE_URL ───────────────────

  describe('AC-12: missing AUTH_SERVICE_URL should cause startup failure', () => {
    it('AC-12: startServer() should throw or reject when AUTH_SERVICE_URL is missing', async () => {
      delete process.env.AUTH_SERVICE_URL;

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { startServer } = await import('../../../src/index.js');

      await expect(startServer()).rejects.toThrow();
    });
  });
});
