/**
 * Unit Tests: session-store (Redis-backed session helpers)
 *
 * Story   : RAILREPAY-WEB-BFF-002
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates src/lib/session-store.ts.
 * Failure reason: "Cannot find module '../../src/lib/session-store.js'"
 *
 * AC coverage map:
 *   AC-2: getSession(sessionId) reads bff:session:<sid> from Redis; returns parsed JSON or null.
 *         Slides TTL via EXPIRE to 30d on every successful read.
 *   AC-3: createSession(data) generates UUID v4 sid, writes bff:session:<sid> with EX 2592000,
 *         returns { sessionId, expiresAt }.
 *   AC-10: session-store imports @railrepay/redis-cache or @railrepay/winston-logger (not console.log).
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-014 — TDD
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  happyPathSession,
  minimalSession,
  sessionRedisKey,
  SESSION_TTL_SECONDS,
  computeExpiresAt,
} from '../fixtures/session-data.js';

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
const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  expire: vi.fn(),
  del: vi.fn(),
  ping: vi.fn().mockResolvedValue('PONG'),
  on: vi.fn().mockReturnThis(),
};

vi.mock('ioredis', () => ({
  default: vi.fn(() => mockRedis),
  Redis: vi.fn(() => mockRedis),
}));

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-002: session-store unit tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── AC-2: getSession ───────────────────────────────────────────────────────

  describe('AC-2: getSession(sessionId) — reads and slides TTL', () => {
    it('AC-2: should read bff:session:<sid> key from Redis', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getSession } = await import('../../src/lib/session-store.js');

      mockRedis.get.mockResolvedValue(JSON.stringify(happyPathSession));
      mockRedis.expire.mockResolvedValue(1);

      await getSession(mockRedis, happyPathSession.session_id);

      const expectedKey = sessionRedisKey(happyPathSession.session_id);
      expect(mockRedis.get).toHaveBeenCalledWith(expectedKey);
    });

    it('AC-2: should return parsed SessionData when Redis key exists', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getSession } = await import('../../src/lib/session-store.js');

      mockRedis.get.mockResolvedValue(JSON.stringify(happyPathSession));
      mockRedis.expire.mockResolvedValue(1);

      const result = await getSession(mockRedis, happyPathSession.session_id);

      expect(result).not.toBeNull();
      expect(result!.user_id).toBe(happyPathSession.user_id);
      expect(result!.session_id).toBe(happyPathSession.session_id);
    });

    it('AC-2: should return null when Redis key does not exist', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getSession } = await import('../../src/lib/session-store.js');

      mockRedis.get.mockResolvedValue(null);

      const result = await getSession(mockRedis, 'sid-does-not-exist');

      expect(result).toBeNull();
    });

    it('AC-2: should slide TTL via EXPIRE to 2592000 on successful read', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getSession } = await import('../../src/lib/session-store.js');

      mockRedis.get.mockResolvedValue(JSON.stringify(happyPathSession));
      mockRedis.expire.mockResolvedValue(1);

      await getSession(mockRedis, happyPathSession.session_id);

      const expectedKey = sessionRedisKey(happyPathSession.session_id);
      expect(mockRedis.expire).toHaveBeenCalledWith(expectedKey, SESSION_TTL_SECONDS);
    });

    it('AC-2: should NOT call EXPIRE when Redis key does not exist', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getSession } = await import('../../src/lib/session-store.js');

      mockRedis.get.mockResolvedValue(null);

      await getSession(mockRedis, 'sid-missing-key');

      expect(mockRedis.expire).not.toHaveBeenCalled();
    });

    it('AC-2: should use key format bff:session:<sessionId>', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getSession } = await import('../../src/lib/session-store.js');

      const customSid = 'custom-session-id-xyz';
      mockRedis.get.mockResolvedValue(null);

      await getSession(mockRedis, customSid);

      expect(mockRedis.get).toHaveBeenCalledWith(`bff:session:${customSid}`);
    });
  });

  // ─── AC-3: createSession ────────────────────────────────────────────────────

  describe('AC-3: createSession(data) — generates UUID, writes with EX 2592000, returns {sessionId, expiresAt}', () => {
    it('AC-3: should write session data to bff:session:<uuid> with EX 2592000', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createSession } = await import('../../src/lib/session-store.js');

      mockRedis.set.mockResolvedValue('OK');

      await createSession(mockRedis, {
        user_id: minimalSession.user_id,
        access_token: minimalSession.access_token,
      });

      // set() called once with EX option
      expect(mockRedis.set).toHaveBeenCalledTimes(1);
      const [key, _value, exFlag, exVal] = mockRedis.set.mock.calls[0];
      expect(key).toMatch(/^bff:session:[0-9a-f-]{36}$/);
      expect(exFlag).toBe('EX');
      expect(exVal).toBe(SESSION_TTL_SECONDS);
    });

    it('AC-3: should store JSON-stringified value at the Redis key', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createSession } = await import('../../src/lib/session-store.js');

      mockRedis.set.mockResolvedValue('OK');

      await createSession(mockRedis, {
        user_id: 'usr-json-test',
        access_token: 'tok-json-test',
      });

      const [_key, value] = mockRedis.set.mock.calls[0];
      // Value must be valid JSON
      expect(() => JSON.parse(value)).not.toThrow();
      const parsed = JSON.parse(value);
      expect(parsed.user_id).toBe('usr-json-test');
    });

    it('AC-3: should return { sessionId, expiresAt } where sessionId is UUID v4', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createSession } = await import('../../src/lib/session-store.js');

      mockRedis.set.mockResolvedValue('OK');

      const result = await createSession(mockRedis, {
        user_id: minimalSession.user_id,
        access_token: minimalSession.access_token,
      });

      expect(result).toHaveProperty('sessionId');
      expect(result).toHaveProperty('expiresAt');
      // sessionId must be UUID v4
      expect(result.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('AC-3: should return expiresAt ≈ now + 30 days', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createSession } = await import('../../src/lib/session-store.js');

      mockRedis.set.mockResolvedValue('OK');

      const beforeMs = Date.now();
      const result = await createSession(mockRedis, {
        user_id: minimalSession.user_id,
        access_token: minimalSession.access_token,
      });
      const afterMs = Date.now();

      const expectedMin = computeExpiresAt(beforeMs);
      const expectedMax = computeExpiresAt(afterMs);
      const actual = new Date(result.expiresAt);

      expect(actual.getTime()).toBeGreaterThanOrEqual(expectedMin.getTime() - 1000);
      expect(actual.getTime()).toBeLessThanOrEqual(expectedMax.getTime() + 1000);
    });

    it('AC-3: each call should generate a different UUID', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createSession } = await import('../../src/lib/session-store.js');

      mockRedis.set.mockResolvedValue('OK');

      const r1 = await createSession(mockRedis, { user_id: 'usr-a', access_token: 'tok-a' });
      const r2 = await createSession(mockRedis, { user_id: 'usr-b', access_token: 'tok-b' });

      expect(r1.sessionId).not.toBe(r2.sessionId);
    });
  });

  // ─── AC-10: Infrastructure wiring ─────────────────────────────────────────

  describe('AC-10: session-store must use @railrepay/winston-logger (not console.log)', () => {
    it('AC-10: should not call console.log, console.error, or console.warn', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getSession, createSession } = await import('../../src/lib/session-store.js');

      const consoleSpy = {
        log: vi.spyOn(console, 'log').mockImplementation(() => {}),
        error: vi.spyOn(console, 'error').mockImplementation(() => {}),
        warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      };

      mockRedis.get.mockResolvedValue(JSON.stringify(happyPathSession));
      mockRedis.expire.mockResolvedValue(1);
      mockRedis.set.mockResolvedValue('OK');

      await getSession(mockRedis, happyPathSession.session_id);
      await createSession(mockRedis, { user_id: 'usr-x', access_token: 'tok-x' });

      expect(consoleSpy.log).not.toHaveBeenCalled();
      expect(consoleSpy.error).not.toHaveBeenCalled();
      expect(consoleSpy.warn).not.toHaveBeenCalled();

      consoleSpy.log.mockRestore();
      consoleSpy.error.mockRestore();
      consoleSpy.warn.mockRestore();
    });
  });
});
