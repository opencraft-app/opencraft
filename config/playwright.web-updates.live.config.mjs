import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: fileURLToPath(new URL('../tests/playwright', import.meta.url)), testMatch: 'web-updates.live.spec.mjs', workers: 1,
  timeout: 180_000, expect: { timeout: 20_000 },
  outputDir: fileURLToPath(new URL('../.local/playwright/web-updates-live/results', import.meta.url)), reporter: 'list',
  use: {
    locale: process.env.OPENCRAFT_WEB_TEST_LOCALE || 'en-US',
    viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true,
    trace: 'off', video: 'off', screenshot: 'off',
    launchOptions: { executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
      args: ['--no-sandbox', ...(process.env.OPENCRAFT_HOST_RESOLVER_RULES ? [`--host-resolver-rules=${process.env.OPENCRAFT_HOST_RESOLVER_RULES}`] : [])] },
  },
});
