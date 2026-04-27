import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Provide test-safe placeholders so tests that import src/ modules
    // don't fail on missing env vars during module evaluation.
    // Integration tests override these via their own beforeAll/afterAll hooks.
    env: {
      PORT: '3000',
      REDIS_URL: 'redis://localhost:6379',
      AUTH_SERVICE_URL: 'http://localhost:9999',
      ALLOWED_ORIGINS: 'https://railrepay-web-app-bff-production.up.railway.app,http://localhost:3000',
      // Test-safe JWT_SECRET placeholder (≥32 chars). Tests that need a different
      // value override process.env.JWT_SECRET in their own beforeEach.
      JWT_SECRET: 'test-secret-32-chars-minimum-aaa',
      // Test-safe OCR_SERVICE_URL placeholder (SOP-IMPROVEMENT-004, WEB-BFF-004 US-2).
      // Integration tests override this via beforeAll.
      OCR_SERVICE_URL: 'http://ocr-stub.test',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        '*.config.*',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 75,
      },
    },
    testTimeout: 120000, // Testcontainers can take time to start
    hookTimeout: 120000,
  },
});
