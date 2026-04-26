/**
 * Handler: POST /api/auth/otp/start
 *
 * Validates phone_e164 (E.164 regex) and channel (BFF enum: web | rn | swift).
 * Calls authServiceClient.startOtp and passes through the response.
 *
 * Story   : RAILREPAY-WEB-BFF-003
 * AC-1.1  : 202 { status: 'sent' } when auth-service returns 202
 * AC-1.2  : 400 { error: 'invalid_request', details: 'phone_e164' } without calling auth-service
 * AC-1.3  : 400 { error: 'invalid_request', details: 'channel' } for channel='whatsapp' or unknown
 * AC-1.4  : Pass-through 429 from auth-service
 * AC-1.5  : Pass-through 503 from auth-service
 * AC-1.6  : 503 { error: 'upstream_unavailable' } on timeout (5s AbortController)
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-023 — Web Channel BFF Architecture
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { type Request, type Response } from 'express';
import { createLogger } from '@railrepay/winston-logger';
import { startOtp } from '../lib/auth-service-client.js';

const logger = createLogger({
  serviceName: process.env.SERVICE_NAME ?? 'web-app-bff',
  level: process.env.LOG_LEVEL ?? 'info',
  environment: process.env.NODE_ENV ?? 'development',
});

/** E.164 phone validation regex (matches auth-service exactly — human-locked decision) */
const PHONE_E164_REGEX = /^\+[1-9]\d{1,14}$/;

/** BFF channel enum — NO 'whatsapp' (human-locked decision OQ-A) */
const VALID_CHANNELS = new Set(['web', 'rn', 'swift']);

/**
 * Redact phone for logging — show only last 4 digits.
 * E.g. '+447700900123' → '+44****0123'
 */
function redactPhone(phone: string): string {
  if (!phone || phone.length < 5) return '****';
  const last4 = phone.slice(-4);
  const prefix = phone.slice(0, 3);
  return `${prefix}****${last4}`;
}

/**
 * POST /api/auth/otp/start handler
 */
export async function handleOtpStart(req: Request, res: Response): Promise<void> {
  const { phone_e164, channel } = req.body as { phone_e164?: string; channel?: string };

  // AC-1.2: validate phone_e164
  if (!phone_e164 || !PHONE_E164_REGEX.test(phone_e164)) {
    logger.warn('handleOtpStart: invalid phone_e164', {
      component: 'web-app-bff/otp-start-handler',
      phone: phone_e164 ? redactPhone(phone_e164) : 'missing',
    });
    res.status(400).json({ error: 'invalid_request', details: 'phone_e164' });
    return;
  }

  // AC-1.3: validate channel
  if (!channel || !VALID_CHANNELS.has(channel)) {
    logger.warn('handleOtpStart: invalid channel', {
      component: 'web-app-bff/otp-start-handler',
      channel: channel ?? 'missing',
    });
    res.status(400).json({ error: 'invalid_request', details: 'channel' });
    return;
  }

  // Forward correlation ID to auth-service (AC-1.1)
  const correlationId = req.headers['x-correlation-id'] as string | undefined;

  logger.info('handleOtpStart: forwarding to auth-service', {
    component: 'web-app-bff/otp-start-handler',
    phone: redactPhone(phone_e164),
    channel,
  });

  // AC-1.1 / AC-1.4 / AC-1.5 / AC-1.6: call auth-service and pass through response
  const { statusCode, body } = await startOtp(phone_e164, channel, correlationId);

  res.status(statusCode).json(body);
}
