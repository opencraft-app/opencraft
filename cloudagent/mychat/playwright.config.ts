import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.MYCHAT_E2E_PORT ?? "5173");
const baseURL = process.env.MYCHAT_E2E_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 15 * 60 * 1000,
  expect: {
    timeout: 90 * 1000,
  },
  use: {
    baseURL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: process.env.MYCHAT_E2E_BASE_URL
    ? undefined
    : {
        command: `pnpm dev -- --host 127.0.0.1 --port ${port}`,
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120 * 1000,
      },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
