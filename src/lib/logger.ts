/**
 * Centralized Logger for web-app-bff
 *
 * Uses @railrepay/winston-logger for structured logging with correlation IDs (ADR-002).
 * Provides a singleton logger instance.
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { createLogger, Logger } from '@railrepay/winston-logger';

let loggerInstance: Logger | null = null;

/**
 * Get or create the singleton logger instance for web-app-bff.
 *
 * @returns Winston Logger instance
 */
export function getLogger(): Logger {
  if (!loggerInstance) {
    loggerInstance = createLogger({
      serviceName: process.env.SERVICE_NAME || 'web-app-bff',
      level: process.env.LOG_LEVEL || 'info',
      environment: process.env.NODE_ENV || 'development',
    });
  }
  return loggerInstance;
}

/**
 * Reset logger instance (for testing).
 */
export function resetLogger(): void {
  loggerInstance = null;
}
