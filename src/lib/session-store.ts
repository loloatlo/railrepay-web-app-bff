/**
 * Redis-backed session store for web-app-bff
 *
 * Provides getSession and createSession helpers that read/write
 * JSON-serialised SessionData values at keys bff:session:<sid>.
 *
 * Story   : RAILREPAY-WEB-BFF-002
 * AC-2    : getSession reads and slides TTL
 * AC-3    : createSession writes with EX 2592000, returns {sessionId, expiresAt}
 * AC-10   : Uses @railrepay/winston-logger (not console.log)
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '@railrepay/winston-logger';
import type { Redis } from 'ioredis';

const logger = createLogger({
  serviceName: process.env.SERVICE_NAME ?? 'web-app-bff',
  level: process.env.LOG_LEVEL ?? 'info',
  environment: process.env.NODE_ENV ?? 'development',
});

/** 30-day TTL in seconds */
export const SESSION_TTL_SECONDS = 2592000;

/** Shape of a persisted session in Redis */
export interface SessionData {
  user_id: string;
  session_id: string;
  access_token: string;
  refresh_at_iso: string;
  created_at_iso: string;
  /** Auth-service session_id (two-id model — WEB-BFF-003) */
  auth_service_session_id?: string;
}

/** Minimum input needed to create a new session */
export interface CreateSessionInput {
  user_id: string;
  access_token: string;
  /** Auth-service session_id stored alongside BFF UUID (two-id model — WEB-BFF-003) */
  auth_service_session_id?: string;
}

/** Result returned from createSession */
export interface CreateSessionResult {
  sessionId: string;
  expiresAt: Date;
}

/**
 * Build the Redis key for a session ID.
 * Key format: bff:session:<sid>
 */
export function sessionRedisKey(sessionId: string): string {
  return `bff:session:${sessionId}`;
}

/**
 * Retrieve a session from Redis by session ID.
 * Returns null if the key does not exist.
 * Slides the TTL to SESSION_TTL_SECONDS on every successful read.
 *
 * @param redis - ioredis client
 * @param sessionId - session identifier (UUID)
 * @returns Parsed SessionData or null
 */
export async function getSession(
  redis: Pick<Redis, 'get' | 'expire'>,
  sessionId: string
): Promise<SessionData | null> {
  const key = sessionRedisKey(sessionId);

  logger.debug('getSession: reading Redis key', {
    component: 'web-app-bff/session-store',
    hasCookie: true,
  });

  const raw = await redis.get(key);

  if (raw === null || raw === undefined) {
    logger.debug('getSession: session not found', {
      component: 'web-app-bff/session-store',
    });
    return null;
  }

  // Slide TTL on successful read
  await redis.expire(key, SESSION_TTL_SECONDS);

  const data = JSON.parse(raw) as SessionData;

  logger.debug('getSession: session retrieved and TTL slid', {
    component: 'web-app-bff/session-store',
  });

  return data;
}

/**
 * Create a new session in Redis.
 * Generates a UUID v4 session ID, writes JSON-serialised SessionData
 * with EX 2592000, and returns {sessionId, expiresAt}.
 *
 * @param redis - ioredis client
 * @param input - user_id and access_token for the new session
 * @returns {sessionId, expiresAt}
 */
export async function createSession(
  redis: Pick<Redis, 'set'>,
  input: CreateSessionInput
): Promise<CreateSessionResult> {
  const sessionId = uuidv4();
  const key = sessionRedisKey(sessionId);
  const now = new Date().toISOString();

  const data: SessionData = {
    user_id: input.user_id,
    session_id: sessionId,
    access_token: input.access_token,
    refresh_at_iso: now,
    created_at_iso: now,
    ...(input.auth_service_session_id !== undefined
      ? { auth_service_session_id: input.auth_service_session_id }
      : {}),
  };

  await redis.set(key, JSON.stringify(data), 'EX', SESSION_TTL_SECONDS);

  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

  logger.info('createSession: session created', {
    component: 'web-app-bff/session-store',
  });

  return { sessionId, expiresAt };
}
