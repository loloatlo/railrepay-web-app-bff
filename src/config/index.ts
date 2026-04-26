/**
 * Configuration module for web-app-bff
 *
 * Reads PORT, AUTH_SERVICE_URL, REDIS_URL, ALLOWED_ORIGINS, JWT_SECRET, and
 * session cookie vars from environment. Throws an Error if any required
 * variable is absent (fail-fast). Provides defaults for optional vars.
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
  /** JWT secret string ≥32 chars (JWT_SECRET env var) */
  jwtSecret: string;
  /** JWT issuer (JWT_ISSUER env var, default 'auth-service') */
  jwtIssuer: string;
  /** JWT audience (JWT_AUDIENCE env var, default 'web-app-bff') */
  jwtAudience: string;
  /** Session cookie name (SESSION_COOKIE_NAME env var, default 'rr_session') */
  sessionCookieName: string;
  /** Session cookie domain (SESSION_COOKIE_DOMAIN env var, default undefined = host-only) */
  sessionCookieDomain: string | undefined;
  /** Session cookie Secure flag (false in test/development, true otherwise) */
  sessionCookieSecure: boolean;
}

/**
 * Load and return the service configuration from environment variables.
 * Throws an Error with a clear message if any required variable is absent
 * or fails validation.
 *
 * @returns Validated Config object
 * @throws Error when a required environment variable is missing or invalid
 */
export function getConfig(): Config {
  const portStr = process.env.PORT;
  const authServiceUrl = process.env.AUTH_SERVICE_URL;
  const redisUrl = process.env.REDIS_URL;
  const allowedOriginsRaw = process.env.ALLOWED_ORIGINS;
  const jwtSecretRaw = process.env.JWT_SECRET;

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

  if (!jwtSecretRaw) {
    throw new Error(
      'web-app-bff: required environment variable JWT_SECRET is not set'
    );
  }

  if (jwtSecretRaw.length < 32) {
    throw new Error(
      `web-app-bff: JWT_SECRET must be at least 32 characters (got ${jwtSecretRaw.length})`
    );
  }

  const port = parseInt(portStr, 10);
  const allowedOrigins = allowedOriginsRaw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const logLevel = process.env.LOG_LEVEL ?? 'info';
  const serviceName = process.env.SERVICE_NAME ?? 'web-app-bff';

  // JWT config
  const jwtSecret = jwtSecretRaw;
  const jwtIssuer = process.env.JWT_ISSUER ?? 'auth-service';
  const jwtAudience = process.env.JWT_AUDIENCE ?? 'web-app-bff';

  // Session cookie config
  const sessionCookieName = process.env.SESSION_COOKIE_NAME ?? 'rr_session';
  const sessionCookieDomain = process.env.SESSION_COOKIE_DOMAIN ?? undefined;

  // SESSION_COOKIE_SECURE: explicit env var takes precedence; otherwise derive from NODE_ENV
  let sessionCookieSecure: boolean;
  if (process.env.SESSION_COOKIE_SECURE !== undefined) {
    sessionCookieSecure = process.env.SESSION_COOKIE_SECURE === 'true';
  } else {
    const nodeEnv = process.env.NODE_ENV;
    sessionCookieSecure = nodeEnv !== 'test' && nodeEnv !== 'development';
  }

  return {
    port,
    authServiceUrl,
    redisUrl,
    allowedOrigins,
    logLevel,
    serviceName,
    jwtSecret,
    jwtIssuer,
    jwtAudience,
    sessionCookieName,
    sessionCookieDomain,
    sessionCookieSecure,
  };
}
