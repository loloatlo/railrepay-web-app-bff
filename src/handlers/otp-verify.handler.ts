/**
 * Handler: POST /api/auth/otp/verify
 *
 * Validates phone_e164, channel, and code (4-10 digit numeric).
 * Calls authServiceClient.verifyOtp. On success:
 *   - Generates BFF-side UUID for the rr_session cookie
 *   - Calls createSession() directly (NOT internal HTTP per Quinn's locked decision)
 *   - Stores auth-service access_token AND session_id in the Redis row (two-id model)
 *   - Sets rr_session cookie: HttpOnly, Secure (production), SameSite=Lax, Max-Age=2592000, Path=/
 *   - Returns 200 { user_id, expires_at } — does NOT echo session_id or access_token
 *
 * Story   : RAILREPAY-WEB-BFF-003
 * AC-2.1  : 200 { user_id, expires_at } + Set-Cookie rr_session=<bff-uuid>
 * AC-2.2  : Redis row contains auth access_token AND auth_service_session_id
 * AC-2.3  : 400 { error: 'invalid_request', details: 'code' } for invalid code
 * AC-2.4  : 401 pass-through when auth-service returns 401; NO cookie, NO Redis write
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { type Request, type Response } from 'express';
import { createLogger } from '@railrepay/winston-logger';
import type { Redis } from 'ioredis';
import { verifyOtp, type VerifyOtpResult } from '../lib/auth-service-client.js';
import { createSession, SESSION_TTL_SECONDS } from '../lib/session-store.js';

const logger = createLogger({
  serviceName: process.env.SERVICE_NAME ?? 'web-app-bff',
  level: process.env.LOG_LEVEL ?? 'info',
  environment: process.env.NODE_ENV ?? 'development',
});

/** E.164 phone validation regex (matches auth-service exactly — human-locked decision) */
const PHONE_E164_REGEX = /^\+[1-9]\d{1,14}$/;

/** BFF channel enum (human-locked decision OQ-A) */
const VALID_CHANNELS = new Set(['web', 'rn', 'swift']);

/** Code validation: 4-10 digit numeric (human-locked decision) */
const CODE_REGEX = /^\d{4,10}$/;

/**
 * Redact phone for logging — show only last 4 digits.
 */
function redactPhone(phone: string): string {
  if (!phone || phone.length < 5) return '****';
  const last4 = phone.slice(-4);
  const prefix = phone.slice(0, 3);
  return `${prefix}****${last4}`;
}

/**
 * POST /api/auth/otp/verify handler factory.
 * Accepts redis for session creation.
 */
export function createOtpVerifyHandler(redis: Pick<Redis, 'set'>) {
  return async function handleOtpVerify(req: Request, res: Response): Promise<void> {
    const { phone_e164, channel, code } = req.body as {
      phone_e164?: string;
      channel?: string;
      code?: string;
    };

    // AC-2.2 / AC-1.2: validate phone_e164
    if (!phone_e164 || !PHONE_E164_REGEX.test(phone_e164)) {
      res.status(400).json({ error: 'invalid_request', details: 'phone_e164' });
      return;
    }

    // AC-1.3: validate channel
    if (!channel || !VALID_CHANNELS.has(channel)) {
      res.status(400).json({ error: 'invalid_request', details: 'channel' });
      return;
    }

    // AC-2.3: validate code — must be 4-10 digit numeric
    if (!code || !CODE_REGEX.test(code)) {
      logger.warn('handleOtpVerify: invalid code', {
        component: 'web-app-bff/otp-verify-handler',
        phone: redactPhone(phone_e164),
      });
      res.status(400).json({ error: 'invalid_request', details: 'code' });
      return;
    }

    const correlationId = req.headers['x-correlation-id'] as string | undefined;

    logger.info('handleOtpVerify: forwarding to auth-service', {
      component: 'web-app-bff/otp-verify-handler',
      phone: redactPhone(phone_e164),
      channel,
    });

    const { statusCode, body } = await verifyOtp(phone_e164, channel, code, correlationId);

    // AC-2.4: auth-service returned 401 — pass through; NO cookie, NO Redis write
    if (statusCode !== 200) {
      res.status(statusCode).json(body);
      return;
    }

    // AC-2.1 / AC-2.2: success — create BFF session (two-id model)
    const verifyResult = body as unknown as VerifyOtpResult;

    const { sessionId, expiresAt } = await createSession(redis, {
      user_id: verifyResult.user_id,
      access_token: verifyResult.access_token,
      auth_service_session_id: verifyResult.session_id,
    });

    // AC-2.1: set rr_session cookie
    const cookieName = process.env.SESSION_COOKIE_NAME ?? 'rr_session';
    const cookieSecure = process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'development';

    res.cookie(cookieName, sessionId, {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS * 1000,
    });

    logger.info('handleOtpVerify: session created and cookie set', {
      component: 'web-app-bff/otp-verify-handler',
    });

    // AC-2.1: return { user_id, expires_at } — do NOT expose session_id or access_token
    res.status(200).json({
      user_id: verifyResult.user_id,
      expires_at: expiresAt.toISOString(),
    });
  };
}
