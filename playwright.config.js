/**
 * End-to-end tests for critical workflows. Runs the production build served by
 * the backend in demo-agent mode (no Gemini calls) against a fresh database,
 * using the locally installed Google Chrome (no browser download required).
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, channel: 'chrome', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: 'chrome' }, testIgnore: /mobile\.spec\.js/ },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, channel: 'chrome' }, testMatch: /mobile\.spec\.js/ }
  ],
  webServer: {
    command: 'npm --prefix frontend run build && rm -f e2e/.tmp/e2e.db* && cd backend && node src/index.js',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: 'production',
      COOKIE_SECURE: 'false',
      PORT: String(PORT),
      GEMINI_API_KEY: '',
      DATABASE_PATH: '../e2e/.tmp/e2e.db',
      DEMO_ANCHOR_DATE: '2026-11-14',
      LOG_LEVEL: 'warn',
      LOGIN_RATE_LIMIT_PER_MIN: '1000'
    }
  }
});
