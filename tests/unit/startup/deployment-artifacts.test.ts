/**
 * Unit Tests: web-app-bff deployment artifacts (Dockerfile, railway.toml, package.json)
 *
 * Story   : RAILREPAY-WEB-BFF-001
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates Dockerfile and railway.toml.
 * Failure reason: files do not exist yet / content checks fail.
 *
 * AC coverage map:
 *   AC-1   package.json has "type": "module", build/test/test:coverage scripts.
 *          All required deps declared.
 *   AC-2   npm run build exits 0 (verified separately in pre-handoff gate; reflected here structurally).
 *   AC-7   Dockerfile exists with correct content (multi-stage Alpine, EXPOSE 3000, HEALTHCHECK, CMD).
 *   AC-8   railway.toml exists with correct deploy config.
 *
 * ADR references:
 *   ADR-005 — Railway native rollback
 *   ADR-008 — Health check endpoint
 *   ADR-014 — TDD
 *   ADR-023 — Web Channel BFF Architecture (stateless — no migrations in CMD)
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

// ─── Service root path ─────────────────────────────────────────────────────────
const SERVICE_ROOT = path.resolve(
  new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  '../../../..'
);

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-WEB-BFF-001: deployment artifacts (unit)', () => {
  // ── AC-1: package.json structure ─────────────────────────────────────────

  describe('AC-1: package.json declares all required deps and scripts', () => {
    const pkgPath = path.join(SERVICE_ROOT, 'package.json');

    it('AC-1: package.json should exist', () => {
      expect(existsSync(pkgPath)).toBe(true);
    });

    it('AC-1: package.json should have "type": "module" (ESM)', () => {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      expect(pkg.type).toBe('module');
    });

    it('AC-1: package.json should have "build" script using tsc', () => {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      expect(pkg.scripts?.build).toBeDefined();
      expect(pkg.scripts.build).toContain('tsc');
    });

    it('AC-1: package.json should have "test" script using vitest', () => {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      expect(pkg.scripts?.test).toBeDefined();
      expect(pkg.scripts.test).toContain('vitest');
    });

    it('AC-1: package.json should have "test:coverage" script using vitest --coverage', () => {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      expect(pkg.scripts?.['test:coverage']).toBeDefined();
      expect(pkg.scripts['test:coverage']).toContain('--coverage');
    });

    // Production dependencies
    const requiredDeps = [
      '@railrepay/winston-logger',
      '@railrepay/metrics-pusher',
      '@railrepay/redis-cache',
      'express',
      'ioredis',
      'cookie-parser',
    ];

    for (const dep of requiredDeps) {
      it(`AC-1: package.json dependencies should declare "${dep}"`, () => {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        expect(pkg.dependencies?.[dep]).toBeDefined();
      });
    }

    // Dev dependencies
    const requiredDevDeps = [
      'vitest',
      'supertest',
      '@types/supertest',
      'testcontainers',
      '@testcontainers/redis',
      'typescript',
      '@types/express',
      '@types/node',
      '@types/cookie-parser',
      '@vitest/coverage-v8',
    ];

    for (const dep of requiredDevDeps) {
      it(`AC-1: package.json devDependencies should declare "${dep}"`, () => {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        expect(pkg.devDependencies?.[dep]).toBeDefined();
      });
    }
  });

  // ── AC-7: Dockerfile ──────────────────────────────────────────────────────

  describe('AC-7: Dockerfile content', () => {
    const dockerfilePath = path.join(SERVICE_ROOT, 'Dockerfile');

    it('AC-7: Dockerfile should exist', () => {
      expect(existsSync(dockerfilePath)).toBe(true);
    });

    it('AC-7: Dockerfile should use node:20-alpine as base image', () => {
      const content = readFileSync(dockerfilePath, 'utf-8');
      expect(content).toContain('node:20-alpine');
    });

    it('AC-7: Dockerfile should be multi-stage (has AS builder and AS production)', () => {
      const content = readFileSync(dockerfilePath, 'utf-8');
      expect(content).toContain('AS builder');
      expect(content).toContain('AS production');
    });

    it('AC-7: Dockerfile should EXPOSE port 3000', () => {
      const content = readFileSync(dockerfilePath, 'utf-8');
      expect(content).toContain('EXPOSE 3000');
    });

    it('AC-7: Dockerfile should have HEALTHCHECK against /health', () => {
      const content = readFileSync(dockerfilePath, 'utf-8');
      expect(content).toContain('HEALTHCHECK');
      expect(content).toContain('/health');
    });

    it('AC-7: Dockerfile CMD should run node dist/index.js directly (NO migrations — BFF is stateless)', () => {
      const content = readFileSync(dockerfilePath, 'utf-8');
      // BFF is stateless — no DB, no migrations. CMD should NOT include migrate:up.
      expect(content).toContain('node dist/index.js');
      expect(content).not.toContain('migrate:up');
    });

    it('AC-7: Dockerfile CMD should NOT include npm run migrate (BFF is stateless — no DB)', () => {
      const content = readFileSync(dockerfilePath, 'utf-8');
      expect(content).not.toContain('migrate');
    });
  });

  // ── AC-8: railway.toml ────────────────────────────────────────────────────

  describe('AC-8: railway.toml content', () => {
    const railwayTomlPath = path.join(SERVICE_ROOT, 'railway.toml');

    it('AC-8: railway.toml should exist', () => {
      expect(existsSync(railwayTomlPath)).toBe(true);
    });

    it('AC-8: railway.toml should specify builder = "DOCKERFILE" (or "dockerfile")', () => {
      const content = readFileSync(railwayTomlPath, 'utf-8');
      // TOML is case-sensitive in values — Railway accepts DOCKERFILE
      expect(content.toLowerCase()).toContain('dockerfile');
    });

    it('AC-8: railway.toml should set healthcheckPath = "/health"', () => {
      const content = readFileSync(railwayTomlPath, 'utf-8');
      expect(content).toContain('/health');
    });

    it('AC-8: railway.toml should set healthcheckTimeout = 100', () => {
      const content = readFileSync(railwayTomlPath, 'utf-8');
      expect(content).toContain('100');
    });

    it('AC-8: railway.toml should set internalPort = 3000', () => {
      const content = readFileSync(railwayTomlPath, 'utf-8');
      expect(content).toContain('3000');
    });

    it('AC-8: railway.toml should set restartPolicyType = "on_failure"', () => {
      const content = readFileSync(railwayTomlPath, 'utf-8');
      expect(content).toContain('on_failure');
    });

    it('AC-8: railway.toml should set restartPolicyMaxRetries = 10', () => {
      const content = readFileSync(railwayTomlPath, 'utf-8');
      expect(content).toContain('10');
    });
  });
});
