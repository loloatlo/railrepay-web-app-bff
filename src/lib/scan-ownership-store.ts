/**
 * Redis-backed scan ownership store for web-app-bff
 *
 * Provides recordScanOwnership and getScanOwner helpers that read/write
 * scan ownership entries at keys bff:scan:<scanId>.
 *
 * Story   : RAILREPAY-WEB-BFF-004
 * AC-11   : BFF stores bff:scan:<scanId> → user_id in Redis with 90d TTL (7776000s) on POST upload.
 *           On GET, BFF checks Redis; absent OR value !== req.session.user_id → 403.
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { createLogger } from '@railrepay/winston-logger';
import type { Redis } from 'ioredis';

const logger = createLogger({
  serviceName: process.env.SERVICE_NAME ?? 'web-app-bff',
  level: process.env.LOG_LEVEL ?? 'info',
  environment: process.env.NODE_ENV ?? 'development',
});

/** 90-day scan ownership TTL in seconds (AC-11) */
export const SCAN_OWNERSHIP_TTL_SECONDS = 7776000;

/**
 * Build the Redis key for a scan ownership entry.
 * Key format: bff:scan:<scanId>
 */
export function scanOwnershipRedisKey(scanId: string): string {
  return `bff:scan:${scanId}`;
}

/**
 * Record scan ownership in Redis.
 * Writes bff:scan:<scanId> → userId with EX 7776000 (90 days).
 *
 * @param redis   - ioredis client (or compatible mock)
 * @param scanId  - UUID scan identifier returned by ocr service
 * @param userId  - user_id of the uploader
 */
export async function recordScanOwnership(
  redis: Pick<Redis, 'set'>,
  scanId: string,
  userId: string
): Promise<void> {
  const key = scanOwnershipRedisKey(scanId);

  logger.debug('recordScanOwnership: writing scan ownership key', {
    component: 'web-app-bff/scan-ownership-store',
  });

  await redis.set(key, userId, 'EX', SCAN_OWNERSHIP_TTL_SECONDS);
}

/**
 * Retrieve the owner user_id for a scan from Redis.
 * Returns null if the key does not exist (scan absent or expired).
 *
 * @param redis  - ioredis client (or compatible mock)
 * @param scanId - UUID scan identifier
 * @returns userId string or null
 */
export async function getScanOwner(
  redis: Pick<Redis, 'get'>,
  scanId: string
): Promise<string | null> {
  const key = scanOwnershipRedisKey(scanId);

  logger.debug('getScanOwner: reading scan ownership key', {
    component: 'web-app-bff/scan-ownership-store',
  });

  const value = await redis.get(key);
  return value ?? null;
}
