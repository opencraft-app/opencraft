import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

// Use the actual HTML/config and delay the application: startup's visible layer,
// not only meta/root attributes, must already have the saved theme's edge color.
const root = resolve("apps/workbench-web");
const server = await createServer({ root, configFile: resolve(root, "vite.config.ts"), logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await server.listen();
  const html = await server.transformIndexHtml("/", await readFile(resolve(root, "index.html"), "utf8"));
  assert.ok(!html.includes("OPENCRAFT_BOOTSTRAP_APPEARANCE"));
  browser = await chromium.launch();
  for (const id of ["neutral", "canvas", "frost", "longing", "lavender", "graphite", "mist"]) for (const mode of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.addInitScript(({ id, mode }) => {
      localStorage.setItem("opencraft.appearance-theme-id", `opencraft.core.${id}`);
      localStorage.setItem("opencraft.appearance-theme", mode);
      Object.defineProperty(navigator, "standalone", { value: true });
    }, { id, mode });
    await context.route("**/*", route => route.request().isNavigationRequest()
      ? route.fulfill({ contentType: "text/html", body: html }) : route.abort());
    const page = await context.newPage();
    await page.goto("http://appearance.test/", { waitUntil: "domcontentloaded" });
    const result = await page.evaluate(() => {
      const root = document.documentElement;
      const splash = document.querySelector("#opencraft-bootstrap")!;
      return { background: getComputedStyle(root).backgroundColor, splash: getComputedStyle(splash).backgroundColor,
        meta: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content,
        edge: root.style.getPropertyValue("--shell-window-edge-background"), phase: root.dataset.windowAppearancePhase,
        applicationLoaded: !!document.querySelector(".app-shell-root") };
    });
    assert.equal(result.phase, "bootstrap"); assert.equal(result.applicationLoaded, false);
    assert.equal(result.background, result.splash, `${id}/${mode}: visible startup layer diverged`);
    assert.equal(result.meta, result.edge);
    if (id === "lavender") assert.notEqual(result.edge, mode === "light" ? "#ffffff" : "#181818");
    await context.close();
  }
  console.log("14 actual HTML startup layers match their selected theme; native iOS pixels unobserved.");
} finally { await browser?.close(); await server.close(); }
