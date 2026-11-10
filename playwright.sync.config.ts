import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/sync.spec.ts',
  fullyParallel: false,
  workers: 1,
  outputDir: './playwright-report/sync-results',
  timeout: 60_000,
  expect: { timeout: 12_000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5190',
    viewport: { width: 1440, height: 1100 },
    locale: 'es-NI', timezoneId: 'America/Managua',
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {},
  },
  webServer: {
    command: 'VITE_SUPABASE_URL=https://konten-sync-test.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_synthetic npm run dev -- --host 0.0.0.0 --port 5190 --strictPort',
    url: 'http://127.0.0.1:5190', reuseExistingServer: false, timeout: 30_000,
  },
});
