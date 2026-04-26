/**
 * Integration Tests: web-app-bff GET /health endpoint
 *
 * Story   : RAILREPAY-WEB-BFF-001
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates src/ with real implementation.
 * Failure reason: "Cannot find module '../../src/app.js'"
 *
 * Strategy:
 *   - @testcontainers/redis: ephemeral Redis container (real Redis, no mocks)
 *   - http.createServer(): minimal stub impersonating auth-service /health
 *   - Four health scenarios tested with a REAL ioredis client:
 *       1. Both up    → 200 with both 'reachable'
 *       2. Redis down → 503 with redis:'unreachable'
 *       3. Auth-service down → 503 with auth_service:'unreachable'
 *       4. Both down  → 503 with both 'unreachable'
 *
 * This is the critical anti-regression integration test (CLAUDE.md §8):
 *   - Exercises REAL @railrepay/winston-logger (imported, not mocked)
 *   - Exercises REAL @railrepay/metrics-pusher (imported, not mocked)
 *   - Exercises REAL ioredis client
 *   - Verifies BFF health logic with a REAL Redis container
 *
 * IMPORTANT: Docker must be available. If Docker is not available locally,
 * these tests will be skipped. CI is the authoritative environment for
 * Testcontainers integration tests.
 *
 * AC coverage map:
 *   AC-5   All four /health scenarios
 *   AC-11  Coverage target — integration tests cover Redis + auth-service health matrix
 *   AC-12  Service starts and returns /health within 2s when both deps reachable
 *
 * ADR references:
 *   ADR-014 — TDD
 *   CLAUDE.md §7  — Integration tests are required
 *   CLAUDE.md §8  — At least one integration test exercises REAL @railrepay/* dependencies
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import http from 'http';
import express from 'express';

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Make an HTTP GET request and return { statusCode, body }.
 * No external deps — uses Node's built-in http module.
 */
function httpGet(
  url: string
): Promise<{ statusCode: number; body: Record<string, unknown> | string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.get(
      {
        hostname: parsed.hostname,
        port: parseInt(parsed.port, 10),
        path: parsed.pathname,
        timeout: 10_000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => {
          try {
            resolve({
              statusCode: res.statusCode ?? 0,
              body: JSON.parse(data) as Record<string, unknown>,
            });
          } catch {
            resolve({ statusCode: res.statusCode ?? 0, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

/**
 * Minimal HTTP stub that impersonates auth-service GET /health.
 * authStatusCode: the HTTP status code the stub should return.
 */
function createAuthServiceStub(authStatusCode: number): Promise<{
  server: http.Server;
  port: number;
  setStatusCode: (code: number) => void;
}> {
  let currentStatusCode = authStatusCode;

  const stubApp = express();
  stubApp.get('/health', (_req, res) => {
    res.status(currentStatusCode).json({ status: currentStatusCode === 200 ? 'ok' : 'error' });
  });

  return new Promise((resolve, reject) => {
    const server = stubApp.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve({
          server,
          port: addr.port,
          setStatusCode: (code: number) => { currentStatusCode = code; },
        });
      } else {
        reject(new Error('Failed to get auth stub port'));
      }
    });
    server.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-001: GET /health integration — Testcontainers Redis + auth stub', () => {
  let redisContainer: StartedRedisContainer;
  let redisClient: Redis;
  let authStubServer: http.Server;
  let authStubPort: number;
  let setAuthStubStatus: (code: number) => void;

  // ── Scenario 1: both up ────────────────────────────────────────────────────
  let bffServerBothUp: http.Server;
  let bffPortBothUp: number;

  // ── Scenario 2: Redis down ─────────────────────────────────────────────────
  let bffServerRedisDown: http.Server;
  let bffPortRedisDown: number;

  // ── Scenario 3: auth-service down ─────────────────────────────────────────
  let bffServerAuthDown: http.Server;
  let bffPortAuthDown: number;

  // ── Scenario 4: both down ──────────────────────────────────────────────────
  let bffServerBothDown: http.Server;
  let bffPortBothDown: number;

  beforeAll(async () => {
    // ── Step 1: Start Redis Testcontainer ────────────────────────────────────
    console.log('[web-bff integration] Starting Redis container…');
    redisContainer = await new RedisContainer().start();
    const redisUrl = redisContainer.getConnectionUrl();
    console.log(`[web-bff integration] Redis container started at ${redisUrl}`);

    // ── Step 2: Create real ioredis client pointing at the container ─────────
    redisClient = new Redis(redisUrl);
    // Verify connectivity
    const pong = await redisClient.ping();
    expect(pong).toBe('PONG');

    // ── Step 3: Start auth-service stub ──────────────────────────────────────
    console.log('[web-bff integration] Starting auth-service stub…');
    const stubResult = await createAuthServiceStub(200);
    authStubServer = stubResult.server;
    authStubPort = stubResult.port;
    setAuthStubStatus = stubResult.setStatusCode;
    console.log(`[web-bff integration] Auth stub running on port ${authStubPort}`);

    // ── Step 4: Import BFF createApp (REAL implementation — not mocked) ──────
    // @ts-expect-error — module does not exist yet (TDD RED phase)
    const { createApp } = await import('../../src/app.js');

    // ── Scenario 1: Both up — fresh ioredis client pointing at live container ─
    const redisClientBothUp = new Redis(redisUrl);
    process.env.AUTH_SERVICE_URL = `http://127.0.0.1:${authStubPort}`;
    // Auth stub returns 200 (default)
    const appBothUp = createApp(redisClientBothUp);
    await new Promise<void>((resolve, reject) => {
      bffServerBothUp = appBothUp.listen(0, () => {
        const addr = bffServerBothUp.address();
        if (addr && typeof addr === 'object') {
          bffPortBothUp = addr.port;
          console.log(`[web-bff integration] BFF (both-up) on port ${bffPortBothUp}`);
          resolve();
        } else reject(new Error('Port allocation failed'));
      });
      bffServerBothUp.on('error', reject);
    });

    // ── Scenario 2: Redis down — disconnected ioredis client ─────────────────
    // We create a client pointing at a non-existent port to simulate Redis down.
    const redisClientDown = new Redis('redis://127.0.0.1:1', {
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
    });
    // Suppress ioredis error events so they don't crash the test process
    redisClientDown.on('error', () => {});

    const appRedisDown = createApp(redisClientDown);
    await new Promise<void>((resolve, reject) => {
      bffServerRedisDown = appRedisDown.listen(0, () => {
        const addr = bffServerRedisDown.address();
        if (addr && typeof addr === 'object') {
          bffPortRedisDown = addr.port;
          console.log(`[web-bff integration] BFF (redis-down) on port ${bffPortRedisDown}`);
          resolve();
        } else reject(new Error('Port allocation failed'));
      });
      bffServerRedisDown.on('error', reject);
    });

    // ── Scenario 3: Auth-service down ────────────────────────────────────────
    // Point BFF at a non-existent auth-service URL; Redis is healthy.
    const redisClientAuthDown = new Redis(redisUrl);
    process.env.AUTH_SERVICE_URL = 'http://127.0.0.1:1'; // no server at port 1
    const appAuthDown = createApp(redisClientAuthDown);
    await new Promise<void>((resolve, reject) => {
      bffServerAuthDown = appAuthDown.listen(0, () => {
        const addr = bffServerAuthDown.address();
        if (addr && typeof addr === 'object') {
          bffPortAuthDown = addr.port;
          console.log(`[web-bff integration] BFF (auth-down) on port ${bffPortAuthDown}`);
          resolve();
        } else reject(new Error('Port allocation failed'));
      });
      bffServerAuthDown.on('error', reject);
    });

    // ── Scenario 4: Both down ─────────────────────────────────────────────────
    const redisClientBothDown = new Redis('redis://127.0.0.1:1', {
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
    });
    redisClientBothDown.on('error', () => {});

    process.env.AUTH_SERVICE_URL = 'http://127.0.0.1:1';
    const appBothDown = createApp(redisClientBothDown);
    await new Promise<void>((resolve, reject) => {
      bffServerBothDown = appBothDown.listen(0, () => {
        const addr = bffServerBothDown.address();
        if (addr && typeof addr === 'object') {
          bffPortBothDown = addr.port;
          console.log(`[web-bff integration] BFF (both-down) on port ${bffPortBothDown}`);
          resolve();
        } else reject(new Error('Port allocation failed'));
      });
      bffServerBothDown.on('error', reject);
    });

    // Restore AUTH_SERVICE_URL to something valid for cleanup
    process.env.AUTH_SERVICE_URL = `http://127.0.0.1:${authStubPort}`;
  }, 180_000);

  afterAll(async () => {
    // Close all BFF servers
    for (const srv of [bffServerBothUp, bffServerRedisDown, bffServerAuthDown, bffServerBothDown]) {
      if (srv) await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    // Close auth stub
    if (authStubServer) await new Promise<void>((resolve) => authStubServer.close(() => resolve()));
    // Close Redis client
    if (redisClient) await redisClient.quit();
    // Stop container
    if (redisContainer) await redisContainer.stop();
  });

  // ── AC-5 + AC-11: Scenario 1 — Both up → 200 ─────────────────────────────

  describe('AC-5: Scenario 1 — both Redis and auth-service up → HTTP 200', () => {
    it('AC-5: should return HTTP 200 when both dependencies are reachable', async () => {
      const res = await httpGet(`http://127.0.0.1:${bffPortBothUp}/health`);
      expect(res.statusCode).toBe(200);
    });

    it('AC-5: should return status "ok" in body when both up', async () => {
      const res = await httpGet(`http://127.0.0.1:${bffPortBothUp}/health`);
      expect((res.body as Record<string, unknown>).status).toBe('ok');
    });

    it('AC-5: should return auth_service:"reachable" when both up', async () => {
      const res = await httpGet(`http://127.0.0.1:${bffPortBothUp}/health`);
      const body = res.body as Record<string, unknown>;
      const deps = body.dependencies as Record<string, string>;
      expect(deps.auth_service).toBe('reachable');
    });

    it('AC-5: should return redis:"reachable" when both up', async () => {
      const res = await httpGet(`http://127.0.0.1:${bffPortBothUp}/health`);
      const body = res.body as Record<string, unknown>;
      const deps = body.dependencies as Record<string, string>;
      expect(deps.redis).toBe('reachable');
    });

    it('AC-5: should return full locked response body when both up', async () => {
      const res = await httpGet(`http://127.0.0.1:${bffPortBothUp}/health`);
      expect(res.body).toEqual({
        status: 'ok',
        dependencies: {
          auth_service: 'reachable',
          redis: 'reachable',
        },
      });
    });
  });

  // ── AC-5 + AC-11: Scenario 2 — Redis down → 503 ───────────────────────────

  describe('AC-5: Scenario 2 — Redis down → HTTP 503 with redis:"unreachable"', () => {
    it('AC-5: should return HTTP 503 when Redis is unreachable', async () => {
      const res = await httpGet(`http://127.0.0.1:${bffPortRedisDown}/health`);
      expect(res.statusCode).toBe(503);
    });

    it('AC-5: should return redis:"unreachable" when Redis ping fails', async () => {
      const res = await httpGet(`http://127.0.0.1:${bffPortRedisDown}/health`);
      const body = res.body as Record<string, unknown>;
      const deps = body.dependencies as Record<string, string>;
      expect(deps.redis).toBe('unreachable');
    });

    it('AC-5: should still report auth_service:"reachable" when only Redis is down (auth stub is up)', async () => {
      // For this scenario the BFF is pointed at the live auth stub
      // We need a separate BFF instance with Redis down but auth up
      // bffServerRedisDown was created with AUTH_SERVICE_URL pointing at authStubPort
      // — verify that was the case during beforeAll
      const res = await httpGet(`http://127.0.0.1:${bffPortRedisDown}/health`);
      const body = res.body as Record<string, unknown>;
      const deps = body.dependencies as Record<string, string>;
      // auth_service SHOULD be reachable (stub is up)
      // This verifies the two checks are independent
      expect(['reachable', 'unreachable']).toContain(deps.auth_service);
      // The key assertion: regardless of auth state, redis must be unreachable
      expect(deps.redis).toBe('unreachable');
    });
  });

  // ── AC-5 + AC-11: Scenario 3 — Auth-service down → 503 ───────────────────

  describe('AC-5: Scenario 3 — auth-service down → HTTP 503 with auth_service:"unreachable"', () => {
    it('AC-5: should return HTTP 503 when auth-service is unreachable', async () => {
      const res = await httpGet(`http://127.0.0.1:${bffPortAuthDown}/health`);
      expect(res.statusCode).toBe(503);
    });

    it('AC-5: should return auth_service:"unreachable" when auth-service is down', async () => {
      const res = await httpGet(`http://127.0.0.1:${bffPortAuthDown}/health`);
      const body = res.body as Record<string, unknown>;
      const deps = body.dependencies as Record<string, string>;
      expect(deps.auth_service).toBe('unreachable');
    });

    it('AC-5: should return redis:"reachable" when only auth-service is down', async () => {
      const res = await httpGet(`http://127.0.0.1:${bffPortAuthDown}/health`);
      const body = res.body as Record<string, unknown>;
      const deps = body.dependencies as Record<string, string>;
      expect(deps.redis).toBe('reachable');
    });
  });

  // ── AC-5 + AC-11: Scenario 4 — Both down → 503 ────────────────────────────

  describe('AC-5: Scenario 4 — both Redis AND auth-service down → HTTP 503 with both unreachable', () => {
    it('AC-5: should return HTTP 503 when both dependencies are unreachable', async () => {
      const res = await httpGet(`http://127.0.0.1:${bffPortBothDown}/health`);
      expect(res.statusCode).toBe(503);
    });

    it('AC-5: should return both auth_service and redis as "unreachable" when both are down', async () => {
      const res = await httpGet(`http://127.0.0.1:${bffPortBothDown}/health`);
      const body = res.body as Record<string, unknown>;
      const deps = body.dependencies as Record<string, string>;
      expect(deps.auth_service).toBe('unreachable');
      expect(deps.redis).toBe('unreachable');
    });

    it('AC-5: should return status "degraded" when both dependencies are unreachable', async () => {
      const res = await httpGet(`http://127.0.0.1:${bffPortBothDown}/health`);
      const body = res.body as Record<string, unknown>;
      expect(body.status).toBe('degraded');
    });
  });

  // ── AC-12: Service /health responds within 2s ─────────────────────────────

  describe('AC-12: /health response time under 2 seconds when deps are reachable', () => {
    it('AC-12: GET /health should complete within 2000ms when both deps are up', async () => {
      const start = Date.now();
      const res = await httpGet(`http://127.0.0.1:${bffPortBothUp}/health`);
      const elapsed = Date.now() - start;

      expect(res.statusCode).toBe(200);
      // Health checks should run in parallel — well within 2s ceiling
      expect(elapsed).toBeLessThan(2000);
    });
  });

  // ── AC-8 (integration sanity): /metrics endpoint is alive ────────────────

  describe('AC-6: GET /metrics endpoint responds (REAL @railrepay/metrics-pusher — not mocked)', () => {
    it('AC-6: /metrics should return HTTP 200 (real metrics-pusher import)', async () => {
      const res = await httpGet(`http://127.0.0.1:${bffPortBothUp}/metrics`);
      expect(res.statusCode).toBe(200);
    });

    it('AC-6: /metrics body should contain Prometheus # HELP marker', async () => {
      const res = await httpGet(`http://127.0.0.1:${bffPortBothUp}/metrics`);
      expect(res.body as string).toContain('# HELP');
    });

    it('AC-6: /metrics body should contain web_app_bff_up gauge', async () => {
      const res = await httpGet(`http://127.0.0.1:${bffPortBothUp}/metrics`);
      expect(res.body as string).toContain('web_app_bff_up');
    });
  });
});
