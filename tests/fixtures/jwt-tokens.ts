/**
 * JWT Token Fixtures — web-app-bff WEB-BFF-002
 *
 * Pre-signed HS256 tokens generated at fixture-load time using `jose`.
 * The TEST_JWT_SECRET is the same value configured in vitest.config.ts test.env
 * so unit tests can verify against the same key without src/ imports.
 *
 * Story   : RAILREPAY-WEB-BFF-002
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these fixtures.
 *
 * Token cases:
 *   valid            — standard valid HS256 token, 15min TTL, correct iss/aud
 *   expired          — identical payload but exp in the past (signed with exp = iat - 60)
 *   wrongAudience    — valid sig but aud=wrong-service
 *   wrongIssuer      — valid sig but iss=wrong-issuer
 *   tamperedSignature — valid token with last 4 chars of signature replaced
 */

import { SignJWT } from 'jose';

/**
 * Shared test secret for HS256.
 * MUST be ≥32 chars (AC-9: JWT_SECRET ≥32 chars).
 * Same value used in vitest.config.ts test.env.JWT_SECRET.
 */
export const TEST_JWT_SECRET = 'test-secret-32-chars-minimum-aaa';
export const TEST_JWT_ISSUER = 'auth-service';
export const TEST_JWT_AUDIENCE = 'web-app-bff';

/** A deterministic user/session ID pair for fixture tokens */
export const TEST_USER_ID = 'usr-fixture-0001';
export const TEST_SESSION_ID = 'sid-fixture-0001';

const secretBytes = new TextEncoder().encode(TEST_JWT_SECRET);

/**
 * All token promises resolved at module load time.
 * Tests import `tokens` and `await tokens` once in beforeAll/beforeEach.
 */
export interface TokenSet {
  /** Valid HS256 token, 15-minute TTL, correct iss/aud */
  valid: string;
  /** Expired HS256 token — exp is 60s before iat */
  expired: string;
  /** Valid signature but aud is not web-app-bff */
  wrongAudience: string;
  /** Valid signature but iss is not auth-service */
  wrongIssuer: string;
  /** Valid token with last 4 chars of signature segment replaced */
  tamperedSignature: string;
}

async function buildTokens(): Promise<TokenSet> {
  const now = Math.floor(Date.now() / 1000);

  const valid = await new SignJWT({ sid: TEST_SESSION_ID })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(TEST_USER_ID)
    .setIssuer(TEST_JWT_ISSUER)
    .setAudience(TEST_JWT_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 900)
    .sign(secretBytes);

  // Expired: exp is in the past (iat - 60s)
  const expired = await new SignJWT({ sid: TEST_SESSION_ID })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(TEST_USER_ID)
    .setIssuer(TEST_JWT_ISSUER)
    .setAudience(TEST_JWT_AUDIENCE)
    .setIssuedAt(now - 120)
    .setExpirationTime(now - 60)
    .sign(secretBytes);

  const wrongAudience = await new SignJWT({ sid: TEST_SESSION_ID })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(TEST_USER_ID)
    .setIssuer(TEST_JWT_ISSUER)
    .setAudience('wrong-service')
    .setIssuedAt(now)
    .setExpirationTime(now + 900)
    .sign(secretBytes);

  const wrongIssuer = await new SignJWT({ sid: TEST_SESSION_ID })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(TEST_USER_ID)
    .setIssuer('wrong-issuer')
    .setAudience(TEST_JWT_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 900)
    .sign(secretBytes);

  // Tamper the last 4 chars of the signature segment
  const parts = valid.split('.');
  const sig = parts[2]!;
  const tamperedSig = sig.slice(0, -4) + (sig.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  const tamperedSignature = [parts[0], parts[1], tamperedSig].join('.');

  return { valid, expired, wrongAudience, wrongIssuer, tamperedSignature };
}

/** Resolved token set — await this in beforeAll */
export const tokens: Promise<TokenSet> = buildTokens();
