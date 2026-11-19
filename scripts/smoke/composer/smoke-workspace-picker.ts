import assert from "node:assert/strict";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  cacheDir: "node_modules/.vite-workspace-picker",
  esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "workspace-picker",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/workspace-picker.tsx"></script>',
          );
        });
      },
    },
  ],
});
await vite.listen();
const browser = await chromium.launch({
  executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
  args: ["--no-sandbox"],
});
try {
  for (const touch of [false, true]) {
    const context = await browser.newContext({
      viewport: { width: touch ? 390 : 1280, height: 844 },
      hasTouch: touch,
      isMobile: touch,
    });
    await context.addInitScript("window.__name=value=>value");
    const page = await context.newPage(),
      errors: string[] = [];
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => errors.push(error.message));
    // Hold the lazy menus to prove typing and editor identity survive their arrival.
    let releaseMenus!: () => void;
    const menusReady = new Promise<void>((resolve) => {
      releaseMenus = resolve;
    });
    await page.route("**/draft-execution-utility-bar.tsx*", async (route) => {
      await menusReady;
      await route.continue();
    });
    await page.goto(`${vite.resolvedUrls!.local[0]}?toolbar${touch ? "&theme=dark" : "&desktop"}`, {
      waitUntil: "domcontentloaded",
    });
    const editor = page.locator(".opencraft-composer-editor");
    await editor.waitFor();
    await editor.fill("Keep this workspace draft");
    await editor.evaluate((element) => {
      (window as any).keptEditor = element;
    });
    assert.equal(await page.getByRole("button", { name: "Run environment", exact: true }).count(), 0);
    releaseMenus();
    const choose = async (button: string, item: string) => {
      const trigger = page.getByRole("button", { name: button, exact: true });
      await trigger.scrollIntoViewIfNeeded();
      if (touch) await trigger.tap();
      else await trigger.click();
      await page.getByRole("menuitem").filter({ hasText: item }).click();
    };
    await choose("Run environment", "e2b");
    await choose("Workspace source", "Shared library");
    await choose("Run environment", "other");
    await page.locator("[data-sonner-toast]").filter({ hasText: "empty workspace" }).waitFor();
    await page.keyboard.press("Escape");
    let target = await page.evaluate(() => (window as any).picker.execution());
    assert.equal(target.execution.environment.configurationId, "e2b");
    assert.equal(target.execution.workspace.source.libraryId, "shared");
    assert.equal(target.execution.workspace.cwd, null);
    await page.evaluate(() => (window as any).picker.setAvailable(false));
    const sourceTrigger = page.getByRole("button", { name: "Workspace source", exact: true });
    await sourceTrigger.scrollIntoViewIfNeeded();
    if (touch) await sourceTrigger.tap();
    else await sourceTrigger.click();
    await page.screenshot({ path: `/tmp/workspace-picker-${touch ? "touch" : "desktop"}.png` });
    assert.equal(
      await page.getByRole("menuitem").filter({ hasText: "Shared library" }).getAttribute("data-disabled"),
      "",
    );
    assert.equal(await page.locator(".opencraft-composer-submit").isDisabled(), true);
    await page.keyboard.press("Escape");
    await page.evaluate(() => (window as any).picker.setAvailable(true));
    await choose("Workspace source", "Use an empty workspace");
    await choose("Run environment", "other");
    target = await page.evaluate(() => (window as any).picker.execution());
    assert.equal(target.execution.environment.configurationId, "other");
    assert.equal(target.execution.workspace.source, undefined);
    assert.equal(await editor.innerText(), "Keep this workspace draft");
    assert.equal(await editor.evaluate((element) => element === (window as any).keptEditor), true);
    assert.deepEqual(errors, []);
    console.log(`Workspace picker ${touch ? "touch dark" : "desktop light"} passed`);
    await context.close();
  }
} finally {
  await browser.close();
  await vite.close();
}
