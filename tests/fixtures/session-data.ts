/**
 * Session Data Fixtures — web-app-bff WEB-BFF-002
 *
 * Sample SessionData records for use across unit and integration tests.
 * Covers happy path, edge cases, boundary values, and empty/null scenarios.
 *
 * Story   : RAILREPAY-WEB-BFF-002
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these fixtures.
 *
 * SessionData shape (locked by AC-2/AC-3/AC-4):
 *   {
 *     user_id: string;        -- UUID or stable user identifier
 *     session_id: string;     -- UUID v4 assigned at session creation
 *     access_token: string;   -- HS256 JWT for downstream service calls
 *     refresh_at_iso: string; -- ISO-8601 timestamp: when access_token was last refreshed
 *     created_at_iso: string; -- ISO-8601 timestamp: session creation time
 *   }
 *
 * Redis key: bff:session:<session_id>
 * Redis TTL: EX 2592000 (30 days = 2,592,000 seconds)
 */

export interface SessionData {
  user_id: string;
  session_id: string;
  access_token: string;
  refresh_at_iso: string;
  created_at_iso: string;
}

/** 30-day TTL in seconds (AC-3: EX 2592000) */
export const SESSION_TTL_SECONDS = 2592000;

/** Happy-path session — recently created, valid user and session IDs */
export const happyPathSession: SessionData = {
  user_id: 'usr-00000001-aaaa-bbbb-cccc-000000000001',
  session_id: 'sid-00000001-aaaa-bbbb-cccc-000000000001',
  access_token: 'eyJhbGciOiJIUzI1NiJ9.fixture.happypath',
  refresh_at_iso: '2026-04-26T10:00:00.000Z',
  created_at_iso: '2026-04-26T10:00:00.000Z',
};

/** Second distinct session for same user — needed for multi-session boundary tests */
export const secondSession: SessionData = {
  user_id: 'usr-00000001-aaaa-bbbb-cccc-000000000001', // same user
  session_id: 'sid-00000002-aaaa-bbbb-cccc-000000000002', // different session
  access_token: 'eyJhbGciOiJIUzI1NiJ9.fixture.secondsession',
  refresh_at_iso: '2026-04-26T10:05:00.000Z',
  created_at_iso: '2026-04-26T10:05:00.000Z',
};

/** Session for a different user — used in cross-user boundary tests */
export const differentUserSession: SessionData = {
  user_id: 'usr-00000002-dddd-eeee-ffff-000000000002',
  session_id: 'sid-00000003-dddd-eeee-ffff-000000000003',
  access_token: 'eyJhbGciOiJIUzI1NiJ9.fixture.diffuser',
  refresh_at_iso: '2026-04-26T09:00:00.000Z',
  created_at_iso: '2026-04-26T09:00:00.000Z',
};

/**
 * Session with an already-refreshed access_token — simulates post-refresh state.
 * Used to verify that auth-service-client correctly updates the Redis row.
 */
export const refreshedSession: SessionData = {
  user_id: 'usr-00000001-aaaa-bbbb-cccc-000000000001',
  session_id: 'sid-00000001-aaaa-bbbb-cccc-000000000001',
  access_token: 'eyJhbGciOiJIUzI1NiJ9.fixture.refreshed',
  refresh_at_iso: '2026-04-26T10:15:00.000Z',
  created_at_iso: '2026-04-26T10:00:00.000Z',
};

/**
 * Minimal session — only required fields, no extra keys.
 * Boundary test: what createSession stores vs what getSession returns.
 */
export const minimalSession: SessionData = {
  user_id: 'usr-minimal-0001',
  session_id: 'sid-minimal-0001',
  access_token: 'tok.minimal.0001',
  refresh_at_iso: '2026-04-26T00:00:00.000Z',
  created_at_iso: '2026-04-26T00:00:00.000Z',
};

/**
 * Returns expiry timestamp 30 days from a given base timestamp.
 * Matches AC-3: expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000
 */
export function computeExpiresAt(baseMs: number): Date {
  return new Date(baseMs + SESSION_TTL_SECONDS * 1000);
}

/**
 * Build the Redis key for a session ID.
 * Key format locked by AC-2: bff:session:<sid>
 */
export function sessionRedisKey(sessionId: string): string {
  return `bff:session:${sessionId}`;
}
