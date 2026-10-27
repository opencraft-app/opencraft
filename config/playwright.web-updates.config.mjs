import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: fileURLToPath(new URL('../tests/playwright', import.meta.url)), testMatch: ['web-updates.spec.mjs', 'full-upgrade.spec.mjs'],
  // Each worker owns its temporary registry, state directories and ports.
  fullyParallel: true, workers: 2, timeout: 60_000,
  expect: { timeout: 20_000 },
  outputDir: fileURLToPath(new URL('../.local/playwright/web-updates/results', import.meta.url)),
  reporter: [['list'], ['html', { outputFolder: fileURLToPath(new URL('../.local/playwright/web-updates/report', import.meta.url)), open: 'never' }]],
  use: {
    locale: 'en-US', viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] },
  },
});
