import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-terminal-keyboard", esbuild: { jsx: "automatic", target: "esnext" }, server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "terminal-keyboard", configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url !== "/") return next();
    res.setHeader("content-type", "text/html");
    res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/terminal-keyboard.tsx"></script>');
  }); } }] });
const output = ".local/terminal-keyboard";
await mkdir(output, { recursive: true });
await vite.listen();
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
const evidence: unknown[] = [];
try {
  for (const device of [{ name: "iphone", width: 390, height: 844, platform: "iPhone" }, { name: "ipad", width: 1024, height: 1366, platform: "MacIntel" }, { name: "ipad-split", width: 600, height: 1024, platform: "MacIntel" }, { name: "ipad-landscape", width: 1366, height: 1024, platform: "MacIntel" }, { name: "iphone-landscape", width: 844, height: 390, platform: "iPhone" }]) {
    const context = await browser.newContext({ viewport: device, hasTouch: true, isMobile: true });
    await context.addInitScript(({ width, height, platform }) => {
      (window as any).__name = (v: unknown) => v;
      Object.defineProperty(navigator, "platform", { value: platform });
      Object.defineProperty(navigator, "userAgent", { value: platform === "iPhone" ? "iPhone Safari" : "Macintosh Safari" });
      Object.defineProperty(navigator, "maxTouchPoints", { value: 5 });
      const viewport = new EventTarget();
      Object.assign(viewport, { width, height, offsetTop: 0, offsetLeft: 0, scale: 1 });
      Object.defineProperty(window, "visualViewport", { value: viewport });
      (window as any).setViewport = (height: number, offsetTop: number, scale = 1, panOnly = false) => {
        Object.assign(viewport, { height, offsetTop, scale });
        if (!panOnly) viewport.dispatchEvent(new Event("resize")); viewport.dispatchEvent(new Event("scroll"));
      };
      document.addEventListener("DOMContentLoaded", () => { document.documentElement.dataset.uiDensity = "touch"; document.documentElement.dataset.touchNewera = "on"; });
    }, device);
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", e => { errors.push(e.message); console.error("PAGEERROR", e.message); });
    await page.goto(vite.resolvedUrls!.local[0]!);
    const editor = page.locator(".opencraft-composer-editor");
    await editor.waitFor({state:"attached"});
    await page.waitForTimeout(250);
    if (!(await page.locator(".terminal-panel").isVisible())) await page.locator("button.app-shell-header__right-panel-toggle").click();
    await page.locator(".xterm-screen").waitFor();
    await editor.waitFor();
    if (device.name === "ipad") await page.evaluate(() => (window as any).fixture.setThemePreference("dark"));
    // Native keyboard focus reveal is a separate path from viewport numbers.
    // Start with the terminal, shrink while its cursor helper is at the old row,
    // then move directly to Composer without dismissing/resetting the keyboard.
    const focusHeight = Math.round(device.height * .52);
    await page.locator(".xterm-screen").tap({ position: { x: 20, y: 20 } });
    await page.evaluate(height => (window as any).setViewport(height, 0), focusHeight);
    await page.waitForTimeout(200);
    const focusReveal = async () => page.locator(".xterm-helper-textarea").evaluate((element: HTMLTextAreaElement) => {
      element.blur(); element.focus();
      const clips = [];
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (getComputedStyle(parent).overflow === "clip") clips.push({ name: parent.className, top: parent.scrollTop });
      }
      return { terminalTop: document.querySelector(".terminal-panel__host")!.scrollTop, clips };
    });
    if (device.name === "iphone") {
      // Old hidden clip becomes a programmatic scroller when the stale helper
      // is revealed. This is the focus behavior the former viewport-only test missed.
      const oldClip = await page.addStyleTag({ content: ".terminal-panel__host { overflow: hidden !important; }" });
      const negative = await focusReveal();
      assert.ok(negative.terminalTop > 100, JSON.stringify({ negative }));
      evidence.push({ device: device.name, negativeFocusReveal: negative });
      await oldClip.evaluate(element => element.remove());
    }
    const reveal = await focusReveal();
    assert.equal(reveal.terminalTop, 0, "terminal frame is a clip, not a second scrollport");
    assert.ok(reveal.clips.every(clip => clip.top === 0));
    await editor.tap();
    await page.waitForTimeout(200);
    const inspectAnchor = () => page.evaluate(() => {
      const anchor = document.querySelector(".main-content-body")!;
      const overlay = document.querySelector<HTMLElement>(".thread-composer-overlay-host")!;
      const content = document.querySelector(".thread-composer-overlay__content")!.getBoundingClientRect();
      const a = anchor.getBoundingClientRect(), o = overlay.getBoundingClientRect();
      return { anchorTop: a.top, overlayTop: o.top, anchorBottom: a.bottom, overlayBottom: o.bottom,
        bottomGap: a.bottom - content.bottom, localOwner: overlay.parentElement === anchor && overlay.offsetParent === anchor,
        focused: document.activeElement === document.querySelector(".opencraft-composer-editor"),
        scrolledClips: [...document.querySelectorAll<HTMLElement>(".app-shell-root,.main-content-body,.thread-composer-overlay-host,.terminal-panel__host")].filter(e => e.scrollTop !== 0).map(e => e.className) };
    });
    for (const offset of [0, 170, 65, 0]) {
      // Pure pan with the SAME editable still focused; no focus event or resize
      // can accidentally repair a portal which missed the Shell's publication.
      await page.evaluate(([height, top]) => (window as any).setViewport(height, top, 1, true), [focusHeight, offset]);
      await page.waitForTimeout(100);
      const bounds = await inspectAnchor();
      assert.ok(bounds.localOwner && bounds.focused, JSON.stringify(bounds));
      assert.ok(Math.abs(bounds.anchorTop - bounds.overlayTop) < 1 && Math.abs(bounds.anchorBottom - bounds.overlayBottom) < 1, JSON.stringify(bounds));
      assert.ok(bounds.bottomGap >= 7 && bounds.bottomGap <= 9, JSON.stringify(bounds));
      assert.deepEqual(bounds.scrolledClips, []);
      evidence.push({ device: device.name, focusPan: offset, bounds });
    }
    // Change the fixed-containing-block origin independently of VisualViewport.
    // This is a coordinate-contract stress case, not an emulated iOS keyboard.
    await page.evaluate(() => { document.body.style.transform = "translateY(-70px)"; (window as any).setViewport((window as any).visualViewport.height, 0, 1, true); });
    await page.waitForTimeout(100);
    const shifted = await inspectAnchor();
    assert.ok(Math.abs(shifted.bottomGap - 8) < 1 && shifted.localOwner, JSON.stringify(shifted));
    evidence.push({ device: device.name, shiftedOrigin: shifted });
    await page.evaluate(() => { document.body.style.removeProperty("transform"); });
    await page.evaluate(height => (window as any).setViewport(height, 0), device.height);
    await page.waitForTimeout(100);
    await editor.fill("Keep terminal draft");
    if (device.name === "iphone") {
      const oldLayout = await page.addStyleTag({content: ".terminal-panel__inset {bottom: 0 !important}"});
      await page.waitForTimeout(250);
      assert.ok(await page.evaluate(() => document.querySelector(".terminal-panel__host")!.getBoundingClientRect().bottom > document.querySelector(".thread-composer-overlay__content")!.getBoundingClientRect().top), "negative control reproduces original overlap");
      await oldLayout.evaluate(e => e.remove());
    }
    await page.evaluate(() => { (window as any).keptEditor = document.querySelector(".opencraft-composer-editor"); (window as any).keptTerminal = document.querySelector(".xterm"); });
    for (const [height, top, scale] of [[device.height, 0, 1], [Math.round(device.height * .52), 0, 1], [Math.round(device.height * .52), 65, 1], [device.height, 0, 1], [Math.round(device.height * .7), 0, 1.5]]) {
      await page.locator(".xterm-helper-textarea").focus();
      await page.evaluate(([h, t, s]) => (window as any).setViewport(h, t, s, t > 0), [height, top, scale]);
      await page.waitForTimeout(350);
      const geometry = await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>(".terminal-panel__host")!, composer = document.querySelector(".thread-composer-overlay__content")!, screen = document.querySelector(".xterm-screen")!;
        const h = host.getBoundingClientRect(), c = composer.getBoundingClientRect(), s = screen.getBoundingClientRect();
        const root = document.querySelector(".app-shell-root")!.getBoundingClientRect();
        const latest = document.querySelector(".thread-composer-overlay__latest")!;
        return { terminalBottom: h.bottom, screenBottom: s.bottom, composerTop: Math.min(c.top, latest.getClientRects().length ? latest.getBoundingClientRect().top : c.top), composerBottom: c.bottom, rootBottom: root.bottom, keyboard: document.documentElement.dataset.timelineKeyboardOpen,
          rows: (window as any).fixture.sizes.at(-1)?.rows, sameTerminal: document.querySelector(".xterm") === (window as any).keptTerminal, sameEditor: document.querySelector(".opencraft-composer-editor") === (window as any).keptEditor };
      });
      assert.ok(geometry.terminalBottom <= geometry.composerTop + 1, JSON.stringify({ device: device.name, height, top, geometry }));
      assert.ok(geometry.screenBottom <= geometry.composerTop + 1, "last terminal row stays outside composer occlusion");
      assert.ok(geometry.composerBottom <= (scale === 1 ? height + top : device.height) + 1);
      assert.ok(Math.abs(geometry.rootBottom - (scale === 1 ? height + top : device.height)) < 1, "Shell maps the visual origin once and preserves capacity without pinch reflow");
      assert.equal(geometry.keyboard, String(scale === 1 && height + top < device.height));
      assert.ok(geometry.rows > 0); assert.ok(geometry.sameEditor && geometry.sameTerminal);
      assert.equal(await editor.innerText(), "Keep terminal draft");
      evidence.push({ device: device.name, height, top, scale, geometry });
    }
    if (device.name !== "iphone-landscape") {
    await page.evaluate(h => (window as any).setViewport(h, 0), device.height);
    await editor.focus();
    await page.waitForTimeout(250);
    assert.equal(await page.locator(".thread-composer-overlay__summary").getAttribute("aria-expanded"), "false", device.name);
    await page.locator(".thread-composer-overlay__summary").click();
    await editor.focus();
    await page.evaluate(h => (window as any).setViewport(h, 0), Math.round(device.height * .52));
    await page.waitForTimeout(400);
    assert.equal(await page.locator(".thread-composer-overlay__summary").getAttribute("aria-expanded"), "true", device.name);
    const expanded = await page.evaluate(() => ({terminal:document.querySelector(".terminal-panel__host")!.getBoundingClientRect().toJSON(),latest:document.querySelector(".thread-composer-overlay__latest")!.getBoundingClientRect().toJSON(),rows:(window as any).fixture.sizes.at(-1)?.rows}));
    assert.ok(expanded.terminal.bottom <= expanded.latest.top + 1 && expanded.terminal.height > 0, JSON.stringify({device:device.name,expanded}));
    assert.ok(expanded.terminal.height >= 40);
    evidence.push({device:device.name,expanded});
    await page.locator(".thread-composer-overlay__summary").click();
    }
    await page.evaluate(h => (window as any).setViewport(h, 0), Math.round(device.height * .52));
    await editor.focus(); await page.waitForTimeout(350);
    await page.screenshot({ path: `${output}/${device.name}.png` });
    const reserved = await page.locator(".terminal-panel__host").evaluate(e => e.clientHeight);
    await page.evaluate(() => (window as any).fixture.setOverlayEnabled(false));
    await page.waitForTimeout(300);
    assert.ok(await page.locator(".terminal-panel__host").evaluate(e => e.clientHeight) > reserved, "inline mode releases reserve");
    await page.evaluate(() => (window as any).fixture.setOverlayEnabled(true));
    await page.waitForTimeout(300);
    assert.equal(await editor.innerText(), "Keep terminal draft");
    assert.ok(await page.evaluate(() => document.querySelector(".xterm") === (window as any).keptTerminal && document.querySelector(".opencraft-composer-editor") === (window as any).keptEditor));
    await page.waitForTimeout(50);
    const readMaterial = () => page.locator(".opencraft-composer-shell").evaluate(element => {
      const style = getComputedStyle(element, "::before");
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const paint = canvas.getContext("2d")!; paint.fillStyle = style.backgroundColor; paint.fillRect(0, 0, 1, 1);
      return {color:style.backgroundColor, alpha:paint.getImageData(0, 0, 1, 1).data[3] / 255, filter:style.backdropFilter};
    });
    const glass = await readMaterial();
    assert.ok(glass.alpha > 0 && glass.alpha < .5, JSON.stringify(glass));
    await page.emulateMedia({forcedColors:"active"});
    const opaque = await readMaterial();
    assert.equal(opaque.alpha, 1); assert.equal(opaque.filter, "none");
    evidence.push({device:device.name,material:{glass,opaque}});
    assert.deepEqual(errors, []); await context.close();
  }
  console.log(JSON.stringify({ passed: true, cases: evidence.length, output }));
} finally { await writeFile(`${output}/result.json`, JSON.stringify(evidence, null, 2)); await browser.close(); await vite.close(); }
