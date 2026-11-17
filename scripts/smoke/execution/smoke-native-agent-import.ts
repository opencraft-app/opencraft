import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = "/tmp/opencraft-native-agent-import-ui"; await mkdir(output, { recursive: true });
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-native-agent-import", esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "native-import-fixture", configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url !== "/" && !req.url?.startsWith("/?")) return next();
    res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/agent-onboarding.tsx"></script>');
  }); } }],
});
let browser: any;
try {
  await vite.listen(); const base = vite.resolvedUrls!.local[0];
  browser = await chromium.launch({ headless: true, ...(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE } : {}) });
  for (const touch of [false, true]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1100, height: 950 }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage(), errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    const activate = async (target: any) => touch ? target.tap() : target.click();
    await page.goto(base + "?historyOnly=1&history=1&historyAll=1&locale=zh-CN");
    await page.locator('.agent-history-source[data-agent="pi"]').waitFor();
    assert.equal(await page.locator('.agent-history-source').count(), 6);
    for (const theme of ["light", "dark", "lavender"]) {
      await page.evaluate(theme => { const f = (window as any).onboardingFixture; f.setThemePreference(theme === "dark" ? "dark" : "light"); if (theme === "lavender") f.setAppearanceThemeId("opencraft.core.lavender"); }, theme);
      await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-${theme}.png`, animations: "disabled" });
    }
    for (const agent of ["pi", "claude", "codebuddy", "codebuddy-ide"]) {
      await activate(page.locator(`.agent-history-source[data-agent="${agent}"]`).getByRole("button").first());
      const section = page.locator(`.agent-history[data-agent="${agent}"]`);
      await activate(section.getByRole("button", { name: /^project/ }));
      await activate(section.getByRole("checkbox").first());
      await activate(section.getByRole("button", { name: /导入所选会话/ }));
      await page.waitForFunction(agent => (window as any).onboardingFixture.historyImports.at(-1)?.id === agent, agent);
      await page.evaluate(() => (window as any).onboardingFixture.resolve("host-a:import", { imported: [{ id: "11111111-2222-3333-4444-555555555555", threadId: "native-import-fixture" }], failed: [] }));
      await section.getByRole("checkbox").first().waitFor();
      await activate(page.getByRole("button", { name: "选择其他 Agent", exact: true }));
    }
    // Retire old Host selections and pending imports before rendering a remote Host.
    await activate(page.locator('.agent-history-source[data-agent="pi"]').getByRole("button").first());
    const piHistory = page.locator('.agent-history[data-agent="pi"]');
    await activate(piHistory.getByRole("button", { name: "全部文件夹", exact: true }));
    await activate(piHistory.getByRole("button", { name: /^other/ }));
    await activate(page.getByRole("checkbox").first());
    await activate(page.getByRole("button", { name: /导入所选会话/ }));
    await page.evaluate(() => (window as any).onboardingFixture.setHostId("host-b"));
    await page.evaluate(() => (window as any).onboardingFixture.resolve("host-a:import", { imported: [{ id: "old", threadId: "old" }], failed: [] }));
    await page.waitForFunction(() => (window as any).onboardingFixture.calls.includes("host-b:history:pi"));
    assert.equal(await page.getByRole("checkbox", { checked: true }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []); await context.close();
  }
  console.log("PASS native import: six Host-declared Agents; Pi/Claude/CodeBuddy CLI/IDE select, import, Host isolation, stale results, touch and three themes. Host boundary simulated.");
} finally { await browser?.close(); await vite.close(); }
