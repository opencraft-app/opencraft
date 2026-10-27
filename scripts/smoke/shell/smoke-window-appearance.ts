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
  let html = await server.transformIndexHtml("/", await readFile(resolve(root, "index.html"), "utf8"));
  assert.ok(!html.includes("OPENCRAFT_BOOTSTRAP_APPEARANCE"));
  const overlayMeta = '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />';
  assert.equal(html.split(overlayMeta).length, 2, "the overlay policy must be declared once before startup");
  const engine = process.env.OPENCRAFT_APPEARANCE_BROWSER === "webkit" ? webkit : chromium;
  // Linux WebKit does not expose iOS's touch-callout property. Project only that
  // platform predicate when exercising the enabled CSS; never call it native iOS.
  const iosCssProbe = process.env.OPENCRAFT_APPEARANCE_IOS_CSS_PROBE === "1";
  if (iosCssProbe) {
    assert.equal(engine, webkit);
    const projected = html.replace("@supports (-webkit-touch-callout: none)", "@supports (color: red)");
    assert.notEqual(projected, html, "the platform predicate must be present");
    html = projected;
  }
  browser = await engine.launch();
  for (const id of ["neutral", "canvas", "frost", "longing", "lavender", "graphite", "mist"]) for (const mode of ["light", "dark"]) for (const overlay of [true, false]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.addInitScript(({ id, mode }) => {
      localStorage.setItem("opencraft.appearance-theme-id", `opencraft.core.${id}`);
      localStorage.setItem("opencraft.appearance-theme", mode);
      Object.defineProperty(navigator, "standalone", { value: true });
    }, { id, mode });
    await context.route("**/*", route => route.request().isNavigationRequest()
      ? route.fulfill({ contentType: "text/html", body: overlay ? html : html.replace(overlayMeta, "") }) : route.abort());
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
    assert.equal(await page.locator("html").getAttribute("data-window-edge-strategy"), overlay ? "legacy-overlay-requested" : "system-color-extension");
    const supported = iosCssProbe || await page.evaluate(() => CSS.supports("-webkit-touch-callout", "none") && CSS.supports("background-clip", "text"));
    assert.equal(await surface.evaluate(e => getComputedStyle(e).display), supported && !overlay ? "block" : "none");
    if (supported && !overlay) {
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
  console.log(`28 actual HTML startup theme/mode/policy scenes match; overlay requests exclude sampling; iOS CSS predicate projected: ${iosCssProbe}; native iOS system compositing unobserved.`);
} finally { await browser?.close(); await server.close(); }
