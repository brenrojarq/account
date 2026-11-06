import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/pwa.spec.ts',
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4180/account/',
    viewport: { width: 1280, height: 900 },
    locale: 'es-NI',
    timezoneId: 'America/Managua',
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
    launchOptions: existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {},
  },
  webServer: {
    command: 'npm run preview -- --port 4180 --strictPort --base /account/',
    url: 'http://127.0.0.1:4180/account/',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
