/**
 * Integration test shim — re-exports from the real src/app.ts
 *
 * The integration test at tests/integration/health/ imports '../../src/app.js'
 * which resolves to this file (tests/src/app.js) due to relative path depth.
 *
 * This shim re-exports the real createApp factory from src/app.ts so the
 * integration test exercises the actual BFF implementation.
 *
 * NOTE: This file must NOT be modified to change app behaviour — it is a
 * pure re-export bridge for the integration test path resolution.
 */

export { createApp } from '../../src/app.js';
