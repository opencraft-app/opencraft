import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium, webkit } from "playwright";

// Use the actual HTML/config and delay the application: startup's visible layer,
// not only meta/root attributes, must already have the saved theme's edge color.
const root = resolve("apps/workbench-web");
const server = await createServer({ root, configFile: resolve(root, "vite.config.ts"), logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await server.listen();
  const html = await server.transformIndexHtml("/", await readFile(resolve(root, "index.html"), "utf8"));
  assert.ok(!html.includes("OPENCRAFT_BOOTSTRAP_APPEARANCE"));
  const engine = process.env.OPENCRAFT_APPEARANCE_BROWSER === "webkit" ? webkit : chromium;
  browser = await engine.launch();
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
    const surface = page.locator("#opencraft-host-edge-color");
    assert.equal(await surface.count(), 1, "startup must provide one document-owned sampling surface");
    assert.equal(await surface.textContent(), "");
    assert.equal(await surface.getAttribute("aria-hidden"), "true");
    const supported = await page.evaluate(() => CSS.supports("-webkit-touch-callout", "none") && CSS.supports("background-clip", "text"));
    assert.equal(await surface.evaluate(e => getComputedStyle(e).display), supported ? "block" : "none");
    if (supported) {
      const sample = await surface.evaluate(e => { const s = getComputedStyle(e), r = e.getBoundingClientRect();
        return { color: s.backgroundColor, clip: s.backgroundClip, pointer: s.pointerEvents, top: r.top, width: r.width, height: r.height,
          hit: document.elementFromPoint(innerWidth / 2, 4) === e, outsideApplication: !document.querySelector("#root")?.contains(e) }; });
      assert.equal(sample.color, result.background); assert.equal(sample.clip, "text"); assert.equal(sample.pointer, "none");
      assert.equal(sample.top, 0); assert.equal(sample.width, 390); assert.equal(sample.height, 11); assert.equal(sample.hit, false); assert(sample.outsideApplication);
      // The sample has a style color without painting a new strip or intercepting controls.
      await page.addStyleTag({ content: "* { animation: none !important; }" });
      const painted = await page.screenshot(); await surface.evaluate(e => (e as HTMLElement).style.display = "none");
      assert.deepEqual(await page.screenshot(), painted, "empty-text clipping must leave page pixels unchanged");
      await surface.evaluate(e => (e as HTMLElement).style.removeProperty("display"));
      // Theme updates retain the element; ineligible hosts/modes cannot keep it active.
      for (const [host, displayMode, visible] of [
        ["browser", "tab", false], ["electron", "standalone", false], ["native-container", "standalone", false],
        ["embedded", "standalone", false], ["browser", "fullscreen", true], ["browser", "standalone", true],
      ] as const) {
        await page.evaluate(({ host, displayMode }) => { document.documentElement.dataset.windowHost = host; document.documentElement.dataset.windowDisplayMode = displayMode; }, { host, displayMode });
        assert.equal(await surface.evaluate(e => getComputedStyle(e).display), visible ? "block" : "none", `${host}/${displayMode}`);
      }
      await page.evaluate(() => document.documentElement.style.setProperty("--shell-window-edge-background", "rgb(47, 81, 119)"));
      assert.equal(await surface.evaluate(e => getComputedStyle(e).backgroundColor), "rgb(47, 81, 119)");
      assert.equal(await surface.count(), 1);
    }
    await context.close();
  }
  console.log("14 actual HTML startup layers and host edge-color scope/pixels match; native iOS system compositing unobserved.");
} finally { await browser?.close(); await server.close(); }
