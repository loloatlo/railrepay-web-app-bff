/**
 * Unit Tests: scan-ownership-store (Redis-backed scan ownership helpers)
 *
 * Story   : RAILREPAY-WEB-BFF-004
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-27
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates src/lib/scan-ownership-store.ts.
 * Failure reason: "Cannot find module '../../src/lib/scan-ownership-store.js'"
 *
 * AC coverage map:
 *   AC-11: BFF stores bff:scan:<scanId> → user_id in Redis with 90d TTL (7776000s) on POST upload.
 *          On GET, BFF checks Redis; absent OR value !== req.session.user_id → 403.
 *          recordScanOwnership(redis, scanId, userId): sets bff:scan:<scanId> EX 7776000
 *          getScanOwner(redis, scanId): returns userId string or null
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-014 — TDD
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  HAPPY_SCAN_ID,
  SECOND_SCAN_ID,
  PRIMARY_USER,
  SECOND_USER,
  SCAN_OWNERSHIP_TTL_SECONDS,
  scanOwnershipRedisKey,
} from '../../fixtures/scan-data.js';

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

// ─── ioredis mock ─────────────────────────────────────────────────────────────
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

describe('RAILREPAY-WEB-BFF-004: scan-ownership-store unit tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── AC-11: recordScanOwnership ───────────────────────────────────────────

  describe('AC-11: recordScanOwnership(redis, scanId, userId) — writes bff:scan:<scanId> with 90d TTL', () => {
    it('AC-11: should write bff:scan:<scanId> key to Redis with the user_id value', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { recordScanOwnership } = await import('../../../src/lib/scan-ownership-store.js');

      mockRedis.set.mockResolvedValue('OK');

      await recordScanOwnership(mockRedis, HAPPY_SCAN_ID, PRIMARY_USER.user_id);

      const expectedKey = scanOwnershipRedisKey(HAPPY_SCAN_ID);
      expect(mockRedis.set).toHaveBeenCalledWith(
        expectedKey,
        PRIMARY_USER.user_id,
        'EX',
        SCAN_OWNERSHIP_TTL_SECONDS
      );
    });

    it('AC-11: should use key format bff:scan:<scanId>', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { recordScanOwnership } = await import('../../../src/lib/scan-ownership-store.js');

      mockRedis.set.mockResolvedValue('OK');

      await recordScanOwnership(mockRedis, SECOND_SCAN_ID, SECOND_USER.user_id);

      const [key] = mockRedis.set.mock.calls[0];
      expect(key).toBe(`bff:scan:${SECOND_SCAN_ID}`);
    });

    it('AC-11: should set TTL of exactly 7776000 seconds (90 days)', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { recordScanOwnership } = await import('../../../src/lib/scan-ownership-store.js');

      mockRedis.set.mockResolvedValue('OK');

      await recordScanOwnership(mockRedis, HAPPY_SCAN_ID, PRIMARY_USER.user_id);

      const [_key, _value, exFlag, exVal] = mockRedis.set.mock.calls[0];
      expect(exFlag).toBe('EX');
      expect(exVal).toBe(SCAN_OWNERSHIP_TTL_SECONDS); // 7776000
    });

    it('AC-11: should store the user_id as the Redis value (not JSON-encoded)', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { recordScanOwnership } = await import('../../../src/lib/scan-ownership-store.js');

      mockRedis.set.mockResolvedValue('OK');

      await recordScanOwnership(mockRedis, HAPPY_SCAN_ID, PRIMARY_USER.user_id);

      const [_key, value] = mockRedis.set.mock.calls[0];
      // Value must be the plain user_id string
      expect(value).toBe(PRIMARY_USER.user_id);
    });

    it('AC-11: each call for distinct scanIds must write to distinct Redis keys', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { recordScanOwnership } = await import('../../../src/lib/scan-ownership-store.js');

      mockRedis.set.mockResolvedValue('OK');

      await recordScanOwnership(mockRedis, HAPPY_SCAN_ID, PRIMARY_USER.user_id);
      await recordScanOwnership(mockRedis, SECOND_SCAN_ID, SECOND_USER.user_id);

      expect(mockRedis.set).toHaveBeenCalledTimes(2);
      const [firstKey] = mockRedis.set.mock.calls[0];
      const [secondKey] = mockRedis.set.mock.calls[1];
      expect(firstKey).toBe(`bff:scan:${HAPPY_SCAN_ID}`);
      expect(secondKey).toBe(`bff:scan:${SECOND_SCAN_ID}`);
    });
  });

  // ─── AC-11: getScanOwner ───────────────────────────────────────────────────

  describe('AC-11: getScanOwner(redis, scanId) — returns user_id or null', () => {
    it('AC-11: should return the user_id when bff:scan:<scanId> key exists', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getScanOwner } = await import('../../../src/lib/scan-ownership-store.js');

      mockRedis.get.mockResolvedValue(PRIMARY_USER.user_id);

      const result = await getScanOwner(mockRedis, HAPPY_SCAN_ID);

      expect(result).toBe(PRIMARY_USER.user_id);
    });

    it('AC-11: should return null when bff:scan:<scanId> key does not exist (absent → 403 trigger)', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getScanOwner } = await import('../../../src/lib/scan-ownership-store.js');

      mockRedis.get.mockResolvedValue(null);

      const result = await getScanOwner(mockRedis, HAPPY_SCAN_ID);

      expect(result).toBeNull();
    });

    it('AC-11: should read from key bff:scan:<scanId>', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getScanOwner } = await import('../../../src/lib/scan-ownership-store.js');

      mockRedis.get.mockResolvedValue(SECOND_USER.user_id);

      await getScanOwner(mockRedis, SECOND_SCAN_ID);

      expect(mockRedis.get).toHaveBeenCalledWith(`bff:scan:${SECOND_SCAN_ID}`);
    });

    it('AC-11: should return second user_id for second scan (data correctly differentiated)', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { getScanOwner } = await import('../../../src/lib/scan-ownership-store.js');

      mockRedis.get.mockResolvedValue(SECOND_USER.user_id);

      const result = await getScanOwner(mockRedis, SECOND_SCAN_ID);

      expect(result).toBe(SECOND_USER.user_id);
      expect(result).not.toBe(PRIMARY_USER.user_id);
    });
  });

  // ─── Infrastructure: no console.log ───────────────────────────────────────

  describe('Infrastructure: scan-ownership-store must use @railrepay/winston-logger', () => {
    it('should not call console.log, console.error, or console.warn', async () => {
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { recordScanOwnership, getScanOwner } = await import('../../../src/lib/scan-ownership-store.js');

      const consoleSpy = {
        log: vi.spyOn(console, 'log').mockImplementation(() => {}),
        error: vi.spyOn(console, 'error').mockImplementation(() => {}),
        warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      };

      mockRedis.set.mockResolvedValue('OK');
      mockRedis.get.mockResolvedValue(PRIMARY_USER.user_id);

      await recordScanOwnership(mockRedis, HAPPY_SCAN_ID, PRIMARY_USER.user_id);
      await getScanOwner(mockRedis, HAPPY_SCAN_ID);

      expect(consoleSpy.log).not.toHaveBeenCalled();
      expect(consoleSpy.error).not.toHaveBeenCalled();
      expect(consoleSpy.warn).not.toHaveBeenCalled();

      consoleSpy.log.mockRestore();
      consoleSpy.error.mockRestore();
      consoleSpy.warn.mockRestore();
    });
  });
});
