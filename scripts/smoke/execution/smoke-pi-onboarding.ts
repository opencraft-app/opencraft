import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = "/tmp/opencraft-pi-onboarding"; await mkdir(output, { recursive: true });
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-pi-onboarding", esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "pi-onboarding-fixture", configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url !== "/" && !req.url?.startsWith("/?")) return next();
    res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/agent-onboarding.tsx"></script>');
  }); } }],
});
let browser: any;
try {
  await vite.listen(); const base = vite.resolvedUrls!.local[0];
  browser = await chromium.launch({ headless: true, ...(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE } : {}) });
  for (const touch of [false, true]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1100, height: 900 }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage(), errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    const activate = async (target: any) => touch ? target.tap() : target.click();
    await page.goto(base + "?pi=ready");
    const pi = page.locator('li[data-agent="pi"]'); await activate(pi.getByRole("button", { name: "Choose models", exact: true }));
    await page.waitForFunction(() => (window as any).onboardingFixture.calls.includes("host-a:pi"));
    await page.evaluate(() => (window as any).onboardingFixture.setHostId("host-b"));
    await page.evaluate(() => (window as any).onboardingFixture.resolve("host-a:pi", { models: [{ id: "pi-cli:old:late", name: "Old host Pi" }] }));
    await activate(pi.getByRole("button", { name: "Choose models", exact: true }));
    await page.waitForFunction(() => (window as any).onboardingFixture.calls.includes("host-b:pi"));
    await page.evaluate(() => (window as any).onboardingFixture.resolve("host-b:pi", { models: [{ id: "pi-cli:fixture:vision", name: "Pi Vision" }] }));
    const model = pi.getByRole("button", { name: "Pi Vision", exact: true }); await activate(model);
    assert.equal(await page.getByText("Old host Pi", { exact: true }).count(), 0);
    for (const theme of ["light", "dark", "lavender"]) {
      await page.evaluate(theme => { const f = (window as any).onboardingFixture; f.setThemePreference(theme === "dark" ? "dark" : "light"); if (theme === "lavender") f.setAppearanceThemeId("opencraft.core.lavender"); }, theme);
      assert.equal(await model.getAttribute("aria-pressed"), "true");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-${theme}.png`, animations: "disabled" });
    }
    await activate(page.getByRole("button", { name: "Continue", exact: true }));
    await activate(page.getByRole("button", { name: "Start chatting", exact: true }));
    await page.waitForFunction(() => (window as any).onboardingFixture.finished.includes("pi-cli:fixture:vision"));
    await page.goto(base + "?pi=setup&management=1&locale=zh-CN");
    await page.evaluate("Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: async function(text) {window.copiedPiCommand = text;}}})");
    const copy = pi.getByRole("button", { name: "复制配置命令", exact: true }); await activate(copy);
    assert.equal(await page.evaluate(() => (window as any).copiedPiCommand), "pi");
    await pi.getByText("在这台机器的终端中运行 pi，配置模型或完成登录，然后重新检查。", { exact: true }).waitFor();
    assert.equal(await pi.getByRole("button", { name: "登录", exact: true }).count(), 0);
    await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-terminal-setup.png` });
    assert.deepEqual(errors, []); await context.close();
  }
  console.log("PASS Pi setup/model selection, local/remote Host isolation, late results, terminal setup, three themes and touch. Host boundary simulated.");
} finally { await browser?.close(); await vite.close(); }
