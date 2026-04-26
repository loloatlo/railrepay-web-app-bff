/**
 * Configuration module for web-app-bff
 *
 * Reads PORT, AUTH_SERVICE_URL, REDIS_URL, ALLOWED_ORIGINS from environment.
 * Throws an Error if any required variable is absent (fail-fast).
 * Provides defaults for LOG_LEVEL and SERVICE_NAME.
 *
 * ADR references:
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

export interface Config {
  /** HTTP port (PORT env var) */
  port: number;
  /** Auth service base URL (AUTH_SERVICE_URL env var) */
  authServiceUrl: string;
  /** Redis connection URL (REDIS_URL env var) */
  redisUrl: string;
  /** Comma-separated list of allowed CORS origins (ALLOWED_ORIGINS env var) */
  allowedOrigins: string[];
  /** Log level (LOG_LEVEL env var, default 'info') */
  logLevel: string;
  /** Service name (SERVICE_NAME env var, default 'web-app-bff') */
  serviceName: string;
}

/**
 * Load and return the service configuration from environment variables.
 * Throws an Error with a clear message if any required variable is absent.
 *
 * @returns Validated Config object
 * @throws Error when a required environment variable is missing
 */
export function getConfig(): Config {
  const portStr = process.env.PORT;
  const authServiceUrl = process.env.AUTH_SERVICE_URL;
  const redisUrl = process.env.REDIS_URL;
  const allowedOriginsRaw = process.env.ALLOWED_ORIGINS;

  if (!portStr) {
    throw new Error(
      'web-app-bff: required environment variable PORT is not set'
    );
  }

  if (!authServiceUrl) {
    throw new Error(
      'web-app-bff: required environment variable AUTH_SERVICE_URL is not set'
    );
  }

  if (!redisUrl) {
    throw new Error(
      'web-app-bff: required environment variable REDIS_URL is not set'
    );
  }

  if (!allowedOriginsRaw) {
    throw new Error(
      'web-app-bff: required environment variable ALLOWED_ORIGINS is not set'
    );
  }

  const port = parseInt(portStr, 10);
  const allowedOrigins = allowedOriginsRaw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const logLevel = process.env.LOG_LEVEL ?? 'info';
  const serviceName = process.env.SERVICE_NAME ?? 'web-app-bff';

  return {
    port,
    authServiceUrl,
    redisUrl,
    allowedOrigins,
    logLevel,
    serviceName,
  };
}
