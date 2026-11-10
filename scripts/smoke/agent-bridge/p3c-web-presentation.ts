/**
 * Actual Web component presentation check for the two P3c steer shapes.
 *
 * This does not claim a Host->AppServer->Web end-to-end path: P3c only emits
 * `opencraft/steerEvidence/updated`, and the existing Workbench does not yet
 * consume that additive notification. This check renders the existing
 * UserMessageBlock with the same message kinds/statuses the bridge projection
 * declares, then proves no native-steer label is invented and both shapes are
 * visible.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");

const output = resolve(process.env.OPENCRAFT_P3C_WEB_OUTPUT ?? "design/agent-bridge/recordings/p3c");
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-p3c-web",
  esbuild: { jsx: "automatic", target: "esnext" },
  optimizeDeps: { include: ["react", "react-dom", "react-dom/client", "react-intl", "@tanstack/react-query", "motion/react", "sonner", "tslib", "marked", "mermaid", "@deepseek-ai/cordis", "@radix-ui/react-dialog", "@radix-ui/react-alert-dialog", "@radix-ui/react-tooltip", "@radix-ui/react-popover", "@radix-ui/react-dropdown-menu", "@radix-ui/react-context-menu"] },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "p3c-steer-presentation", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/p3c-steer-presentation.tsx"></script>');
    });
  } }],
});
let browser;
try {
  await mkdir(output, { recursive: true });
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ?? "/usr/bin/google-chrome" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(vite.resolvedUrls.local[0]);
  await page.locator('[data-case="copilot-next-turn"]').waitFor({ timeout: 60000 });
  await page.waitForTimeout(1000);
  const copilot = await page.locator('[data-case="copilot-next-turn"]').innerText();
  const amp = await page.locator('[data-case="amp-native-steer"]').innerText();
  const pending = await page.locator('[data-case="amp-pending"]').innerText();
  const copilotKind = await page.locator('[data-case="copilot-next-turn"] [data-message-kind]').getAttribute("data-message-kind");
  const ampKind = await page.locator('[data-case="amp-native-steer"] [data-message-kind]').getAttribute("data-message-kind");
  assert.match(copilot, /STEERED/u);
  assert.match(amp, /STEERED/u);
  assert.doesNotMatch(copilot, /native|inject|真\s*steer/iu);
  assert.doesNotMatch(amp, /native|inject|真\s*steer/iu);
  assert.equal(copilotKind, "user");
  assert.equal(ampKind, "steering");
  assert.equal(errors.length, 0, errors.join("\n"));
  await page.screenshot({ path: resolve(output, "web-steer-presentation.png"), fullPage: true });
  await writeFile(resolve(output, "web-steer-presentation.json"), JSON.stringify({
    viewport: "1280x900",
    engine: "chromium",
    cases: { copilot, amp, pending },
    messageKinds: { copilot: copilotKind, amp: ampKind },
    assertion: "both shapes visible; no native/inject/fake-steer label; distinct steering and user-message presentation",
    limitation: "Component-level presentation only. The current Workbench does not consume opencraft/steerEvidence/updated, and the bridge does not yet emit a durable steeringUserMessage item.",
  }, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ output, copilot, amp, pending }, null, 2));
} finally {
  await browser?.close();
  await vite.close();
}
