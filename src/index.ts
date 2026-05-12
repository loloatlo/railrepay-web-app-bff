/**
 * web-app-bff — entry point
 *
 * Exports:
 *   startServer(opts?)  — creates app, listens on PORT, returns { server, redis }
 *   shutdown(signal, server, redis) — graceful shutdown
 *   app                 — Express instance (set after startServer() completes)
 *
 * Top-level auto-start fires only when process.argv[1] points at this file
 * (i.e. `node dist/index.js`). When imported by Vitest tests, startServer()
 * is NOT called automatically.
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-008 — Health check endpoint
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import http from 'http';
import type { Express } from 'express';
import { type Redis } from 'ioredis';
import { getConfig } from './config/index.js';
import { getLogger } from './lib/logger.js';
import { createRedisClient } from './lib/redis.js';
import { createApp } from './app.js';

/** Options accepted by startServer() */
export interface StartServerOptions {
  /** When true, skip dependency health pre-check (for unit tests) */
  skipDependencyCheck?: boolean;
}

/** Result returned by startServer() */
export interface StartServerResult {
  server: http.Server;
  redis: Redis;
}

/** The running Express app instance (set after startServer succeeds). */
export let app: Express | null = null;

/**
 * Start the web-app-bff HTTP server.
 *
 * Reads PORT, AUTH_SERVICE_URL, REDIS_URL, ALLOWED_ORIGINS from the environment
 * via getConfig(). Throws if config is missing — top-level catch calls process.exit(1).
 *
 * @param opts - Optional startup options
 * @returns { server, redis } for graceful shutdown
 */
export async function startServer(
  opts: StartServerOptions = {}
): Promise<StartServerResult> {
  const logger = getLogger();

  // getConfig() throws on missing required env vars (AC-12)
  const config = getConfig();

  // Create Redis client
  const redis = createRedisClient(config.redisUrl);

  // Create Express app with injected Redis client
  const expressApp = createApp(redis);
  app = expressApp;

  return new Promise<StartServerResult>((resolve, reject) => {
    const server = http.createServer(expressApp);

    server.on('error', reject);

    // BL-273: Explicitly bind to '::' (IPv6 dual-stack) so the BFF listens on
    // both IPv4 (0.0.0.0) and IPv6 (::) simultaneously. Railway's private
    // network is IPv6-only — DNS for .railway.internal returns AAAA records
    // only. Without an explicit host of '::' Node's listen() on Alpine Linux
    // may bind to IPv4 only, causing ECONNREFUSED when the PWA's Next.js
    // rewrite proxy resolves the private hostname to an IPv6 address.
    // Binding '::' on Linux enables dual-stack: existing IPv4 callers
    // (health checks, local dev) continue to work unchanged.
    server.listen(config.port, '::', () => {
      logger.info('web-app-bff started', {
        component: 'web-app-bff/server',
        port: config.port,
        skipDependencyCheck: opts.skipDependencyCheck ?? false,
      });
      resolve({ server, redis });
    });

    // Register graceful shutdown signal handlers
    process.on('SIGTERM', () => {
      void shutdown('SIGTERM', server, redis);
    });
    process.on('SIGINT', () => {
      void shutdown('SIGINT', server, redis);
    });
  });
}

/**
 * Graceful shutdown — close HTTP server then quit Redis client.
 *
 * @param signal - OS signal name (e.g. 'SIGTERM', 'SIGINT')
 * @param server - HTTP server to close
 * @param redis  - Redis client to quit
 */
export async function shutdown(
  signal: string,
  server: http.Server,
  redis: { quit: () => Promise<unknown> }
): Promise<void> {
  const logger = getLogger();

  logger.info(`Received shutdown signal: ${signal}`, {
    component: 'web-app-bff/server',
    signal,
  });

  // Close HTTP server — stop accepting new connections
  await new Promise<void>((resolve) => {
    server.close(() => {
      logger.info('HTTP server closed', {
        component: 'web-app-bff/server',
      });
      resolve();
    });
  });

  // Quit Redis client
  await redis.quit();

  logger.info('Redis client closed', {
    component: 'web-app-bff/server',
  });
}

// ── Auto-start when run as main entry point ──────────────────────────────────
// process.argv[1] is the script path when running `node dist/index.js`.
// Vitest runner sets argv[1] to its own binary, not to our index file,
// so this guard prevents accidental startup during tests.
const argv1 = process.argv[1] ?? '';
const isMain = argv1.endsWith('index.js') || argv1.endsWith('index.ts');

if (isMain) {
  startServer().catch((error: unknown) => {
    const logger = getLogger();
    logger.error('Fatal startup error', {
      component: 'web-app-bff/server',
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
