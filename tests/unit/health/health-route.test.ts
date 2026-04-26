/**
 * Unit Tests: web-app-bff GET /health endpoint
 *
 * Story   : RAILREPAY-WEB-BFF-001
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates src/routes/health.ts.
 * Failure reason: "Cannot find module '../../../src/routes/health.js'"
 *
 * AC coverage map:
 *   AC-5  GET /health returns 200 + { status:'ok', dependencies:{auth_service:'reachable', redis:'reachable'} }
 *         when both Redis and auth-service are reachable.
 *   AC-5  GET /health returns 503 with correct dependency states when EITHER Redis or auth-service is down.
 *   AC-5  Auth-service reachability uses a 2-second timeout.
 *   AC-5  Redis reachability uses a 1-second timeout.
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-008 — Health check endpoint contract
 *   ADR-014 — TDD: tests written before implementation
 *   ADR-023 — Web Channel BFF Architecture
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// @ts-expect-error — module does not exist yet (TDD RED phase)
import { createHealthRouter } from '../../../src/routes/health.js';

// ─── Shared logger mock (ADR-002 / Guideline #11 in jessie-qa-tdd-enforcer.md) ──
// Created OUTSIDE factory so all tests share the SAME mock instance.
const sharedLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

/**
 * Helper: create a mock Redis client with controllable ping() behaviour.
 */
function makeMockRedis(pingBehaviour: 'ok' | 'timeout' | 'error') {
  return {
    ping: vi.fn().mockImplementation(() => {
      if (pingBehaviour === 'ok') {
        return Promise.resolve('PONG');
      }
      if (pingBehaviour === 'timeout') {
        // Simulate a 1.5s delay — exceeds the 1s Redis timeout
        return new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Redis timeout')), 1500)
        );
      }
      // 'error'
      return Promise.reject(new Error('Redis connection refused'));
    }),
  };
}

/**
 * Helper: create a minimal Express-style req/res pair for unit testing a router handler.
 */
function makeReqRes() {
  const req = {
    method: 'GET',
    path: '/health',
    headers: {} as Record<string, string>,
  };
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  const next = vi.fn();
  return { req, res, next };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-001: GET /health (unit)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.clearAllTimers();
  });

  // ── AC-5: Both dependencies reachable → 200 ────────────────────────────────

  describe('AC-5: both Redis and auth-service reachable → HTTP 200', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // Auth-service stub returns 200 immediately
      mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', mockFetch);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('AC-5: should return HTTP 200 when both dependencies are reachable', async () => {
      const redis = makeMockRedis('ok');
      const router = createHealthRouter(redis, { authServiceUrl: 'http://auth-stub:9999' });
      const handler = router.stack[0]?.route?.stack[0]?.handle;
      const { req, res, next } = makeReqRes();

      await handler!(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('AC-5: should return status "ok" in body when both dependencies reachable', async () => {
      const redis = makeMockRedis('ok');
      const router = createHealthRouter(redis, { authServiceUrl: 'http://auth-stub:9999' });
      const handler = router.stack[0]?.route?.stack[0]?.handle;
      const { req, res, next } = makeReqRes();

      await handler!(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'ok' })
      );
    });

    it('AC-5: should return auth_service as "reachable" in dependencies when auth-service returns 200', async () => {
      const redis = makeMockRedis('ok');
      const router = createHealthRouter(redis, { authServiceUrl: 'http://auth-stub:9999' });
      const handler = router.stack[0]?.route?.stack[0]?.handle;
      const { req, res, next } = makeReqRes();

      await handler!(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          dependencies: expect.objectContaining({ auth_service: 'reachable' }),
        })
      );
    });

    it('AC-5: should return redis as "reachable" in dependencies when Redis ping succeeds', async () => {
      const redis = makeMockRedis('ok');
      const router = createHealthRouter(redis, { authServiceUrl: 'http://auth-stub:9999' });
      const handler = router.stack[0]?.route?.stack[0]?.handle;
      const { req, res, next } = makeReqRes();

      await handler!(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          dependencies: expect.objectContaining({ redis: 'reachable' }),
        })
      );
    });

    it('AC-5: should return the full locked response body when both dependencies are healthy', async () => {
      const redis = makeMockRedis('ok');
      const router = createHealthRouter(redis, { authServiceUrl: 'http://auth-stub:9999' });
      const handler = router.stack[0]?.route?.stack[0]?.handle;
      const { req, res, next } = makeReqRes();

      await handler!(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        status: 'ok',
        dependencies: {
          auth_service: 'reachable',
          redis: 'reachable',
        },
      });
    });
  });

  // ── AC-5: Redis unreachable → 503 with redis:'unreachable' ─────────────────

  describe('AC-5: Redis unreachable → HTTP 503 with redis:"unreachable"', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // Auth-service stub returns 200; Redis is the failing dep
      mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', mockFetch);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('AC-5: should return HTTP 503 when Redis ping fails', async () => {
      const redis = makeMockRedis('error');
      const router = createHealthRouter(redis, { authServiceUrl: 'http://auth-stub:9999' });
      const handler = router.stack[0]?.route?.stack[0]?.handle;
      const { req, res, next } = makeReqRes();

      await handler!(req, res, next);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('AC-5: should return status "degraded" in body when Redis is unreachable', async () => {
      const redis = makeMockRedis('error');
      const router = createHealthRouter(redis, { authServiceUrl: 'http://auth-stub:9999' });
      const handler = router.stack[0]?.route?.stack[0]?.handle;
      const { req, res, next } = makeReqRes();

      await handler!(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'degraded' })
      );
    });

    it('AC-5: should return redis:"unreachable" when Redis ping throws', async () => {
      const redis = makeMockRedis('error');
      const router = createHealthRouter(redis, { authServiceUrl: 'http://auth-stub:9999' });
      const handler = router.stack[0]?.route?.stack[0]?.handle;
      const { req, res, next } = makeReqRes();

      await handler!(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          dependencies: expect.objectContaining({ redis: 'unreachable' }),
        })
      );
    });

    it('AC-5: should still report auth_service as "reachable" when only Redis fails', async () => {
      const redis = makeMockRedis('error');
      const router = createHealthRouter(redis, { authServiceUrl: 'http://auth-stub:9999' });
      const handler = router.stack[0]?.route?.stack[0]?.handle;
      const { req, res, next } = makeReqRes();

      await handler!(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          dependencies: expect.objectContaining({ auth_service: 'reachable' }),
        })
      );
    });
  });

  // ── AC-5: Auth-service unreachable → 503 with auth_service:'unreachable' ───

  describe('AC-5: auth-service unreachable → HTTP 503 with auth_service:"unreachable"', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // Auth-service stub returns 500; Redis ping succeeds
      mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      vi.stubGlobal('fetch', mockFetch);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('AC-5: should return HTTP 503 when auth-service /health returns non-2xx', async () => {
      const redis = makeMockRedis('ok');
      const router = createHealthRouter(redis, { authServiceUrl: 'http://auth-stub:9999' });
      const handler = router.stack[0]?.route?.stack[0]?.handle;
      const { req, res, next } = makeReqRes();

      await handler!(req, res, next);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('AC-5: should return auth_service:"unreachable" when auth-service returns 500', async () => {
      const redis = makeMockRedis('ok');
      const router = createHealthRouter(redis, { authServiceUrl: 'http://auth-stub:9999' });
      const handler = router.stack[0]?.route?.stack[0]?.handle;
      const { req, res, next } = makeReqRes();

      await handler!(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          dependencies: expect.objectContaining({ auth_service: 'unreachable' }),
        })
      );
    });

    it('AC-5: should report redis:"reachable" when only auth-service fails', async () => {
      const redis = makeMockRedis('ok');
      const router = createHealthRouter(redis, { authServiceUrl: 'http://auth-stub:9999' });
      const handler = router.stack[0]?.route?.stack[0]?.handle;
      const { req, res, next } = makeReqRes();

      await handler!(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          dependencies: expect.objectContaining({ redis: 'reachable' }),
        })
      );
    });

    it('AC-5: should return auth_service:"unreachable" when auth-service fetch throws (network error)', async () => {
      // Auth-service is completely unreachable (fetch throws, not just 5xx)
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const redis = makeMockRedis('ok');
      const router = createHealthRouter(redis, { authServiceUrl: 'http://auth-stub:9999' });
      const handler = router.stack[0]?.route?.stack[0]?.handle;
      const { req, res, next } = makeReqRes();

      await handler!(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          dependencies: expect.objectContaining({ auth_service: 'unreachable' }),
        })
      );
    });
  });

  // ── AC-5: Both dependencies unreachable → 503 ──────────────────────────────

  describe('AC-5: both Redis AND auth-service unreachable → HTTP 503 with both "unreachable"', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // Both deps are down
      mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      vi.stubGlobal('fetch', mockFetch);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('AC-5: should return HTTP 503 when both dependencies are unreachable', async () => {
      const redis = makeMockRedis('error');
      const router = createHealthRouter(redis, { authServiceUrl: 'http://auth-stub:9999' });
      const handler = router.stack[0]?.route?.stack[0]?.handle;
      const { req, res, next } = makeReqRes();

      await handler!(req, res, next);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('AC-5: should return both dependencies as "unreachable" when both are down', async () => {
      const redis = makeMockRedis('error');
      const router = createHealthRouter(redis, { authServiceUrl: 'http://auth-stub:9999' });
      const handler = router.stack[0]?.route?.stack[0]?.handle;
      const { req, res, next } = makeReqRes();

      await handler!(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        status: 'degraded',
        dependencies: {
          auth_service: 'unreachable',
          redis: 'unreachable',
        },
      });
    });
  });

  // ── AC-5: Redis 1-second timeout is honoured ───────────────────────────────

  describe('AC-5: Redis ping must be subject to a 1-second timeout', () => {
    it('AC-5: should treat Redis as unreachable when ping takes longer than 1 second', async () => {
      // Redis ping simulates a 1.5s delay — must be treated as unreachable
      vi.useFakeTimers();

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', mockFetch);

      const redisSlowPing = {
        ping: vi.fn().mockImplementation(
          () => new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Simulated timeout')), 1500)
          )
        ),
      };

      const router = createHealthRouter(redisSlowPing, { authServiceUrl: 'http://auth-stub:9999' });
      const handler = router.stack[0]?.route?.stack[0]?.handle;
      const { req, res, next } = makeReqRes();

      // Start the handler call — it will be waiting on the slow redis ping
      const handlerPromise = handler!(req, res, next);

      // Advance fake timers past the 1s timeout but not the 1.5s ping delay
      vi.advanceTimersByTime(1100);

      await handlerPromise;

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          dependencies: expect.objectContaining({ redis: 'unreachable' }),
        })
      );

      vi.unstubAllGlobals();
      vi.useRealTimers();
    }, 10000);
  });

  // ── AC-5: Auth-service 2-second timeout is honoured ───────────────────────

  describe('AC-5: auth-service fetch must be subject to a 2-second timeout', () => {
    it('AC-5: should treat auth-service as unreachable when fetch takes longer than 2 seconds', async () => {
      vi.useFakeTimers();

      // Auth-service responds only after 2.5s — exceeds the 2s AbortSignal timeout
      const mockFetch = vi.fn().mockImplementation(
        () => new Promise((_, reject) =>
          setTimeout(() => reject(new Error('AbortError')), 2500)
        )
      );
      vi.stubGlobal('fetch', mockFetch);

      const redis = makeMockRedis('ok');
      const router = createHealthRouter(redis, { authServiceUrl: 'http://auth-stub:9999' });
      const handler = router.stack[0]?.route?.stack[0]?.handle;
      const { req, res, next } = makeReqRes();

      const handlerPromise = handler!(req, res, next);

      // Advance past the 2s auth-service timeout
      vi.advanceTimersByTime(2100);

      await handlerPromise;

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          dependencies: expect.objectContaining({ auth_service: 'unreachable' }),
        })
      );

      vi.unstubAllGlobals();
      vi.useRealTimers();
    }, 10000);
  });
});
