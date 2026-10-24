import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-desktop-trackpad-shell", esbuild: { jsx: "automatic", target: "esnext" }, server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "desktop-trackpad-shell", configureServer(vite) { vite.middlewares.use((req, res, next) => {
    if (req.url !== "/") return next();
    res.setHeader("content-type", "text/html");
    res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/desktop-trackpad-shell.tsx"></script>');
  }); } }] });
const output = process.env.OPENCRAFT_TRACKPAD_SHELL_OUTPUT ?? ".local/desktop-trackpad-shell";
await mkdir(output, { recursive: true });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
const evidence: unknown[] = [];
let activePage: any;
try {
  for (const device of [{ width: 390, height: 844 }, { width: 320, height: 700 }, { width: 430, height: 932 }]) {
    const context = await browser.newContext({ viewport: device, hasTouch: true, isMobile: true });
    await context.addInitScript(({ width, height }) => {
      (window as any).__name = (v: unknown) => v;
      Object.defineProperty(navigator, "platform", { value: "iPhone" });
      Object.defineProperty(navigator, "userAgent", { value: "iPhone Safari" });
      Object.defineProperty(navigator, "maxTouchPoints", { value: 5 });
      const viewport = new EventTarget(); Object.assign(viewport, { width, height, offsetTop: 0, offsetLeft: 0, scale: 1 });
      Object.defineProperty(window, "visualViewport", { value: viewport });
      (window as any).setViewport = (height: number, offsetTop = 0) => {
        Object.assign(viewport, { height, offsetTop }); viewport.dispatchEvent(new Event("resize")); viewport.dispatchEvent(new Event("scroll"));
      };
      document.addEventListener("DOMContentLoaded", () => { document.documentElement.dataset.uiDensity = "touch"; document.documentElement.dataset.touchNewera = "on"; });
    }, device);
    const page = await context.newPage(); activePage = page; const errors: string[] = [];
    page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
    await page.goto(server.resolvedUrls!.local[0]!);
    const panel = page.locator(".cloud-desktop-panel"), pad = page.getByRole("group", { name: "Trackpad", exact: true });
    const editor = page.locator(".opencraft-composer-editor");
    await editor.waitFor({ state: "attached" }); await page.waitForTimeout(250);
    if (!(await panel.isVisible())) await page.locator("button.app-shell-header__right-panel-toggle").click();
    await panel.waitFor(); await editor.fill("Keep this draft");
    await page.getByRole("button", { name: "Take control", exact: true }).tap();
    await page.locator('.cloud-desktop-panel[data-control="controlling"]').waitFor();
    await pad.waitFor();
    await page.waitForTimeout(250);
    await page.evaluate(() => { (window as any).keptCanvas = document.querySelector(".cloud-desktop-panel canvas"); (window as any).keptEditor = document.querySelector(".opencraft-composer-editor"); });
    const geometry = () => page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const p = rect(".ui-desktop-trackpad__surface"), t = rect(".cloud-desktop-panel__toolbar"), m = rect(".ui-desktop-view__frame");
      const c = rect(".thread-composer-overlay__content"), l = rect(".thread-composer-overlay__latest");
      const xs = [.15, .5, .85], ys = [.2, .5, .8];
      return { pad: p.toJSON(), toolbar: t.toJSON(), media: m.toJSON(), composerTop: Math.min(c.top, l.top), composerBottom: c.bottom,
        visibleBottom: window.visualViewport!.height + window.visualViewport!.offsetTop,
        rootBottom: rect(".app-shell-root").bottom,
        hits: ys.flatMap(y => xs.map(x => Boolean(document.elementFromPoint(p.x + p.width * x, p.y + p.height * y)?.closest(".ui-desktop-trackpad__surface")))),
        sameCanvas: document.querySelector(".cloud-desktop-panel canvas") === (window as any).keptCanvas,
        sameEditor: document.querySelector(".opencraft-composer-editor") === (window as any).keptEditor,
        connections: (window as any).fixture.connections,
        reserve: getComputedStyle(document.querySelector(".main-content-body")!).getPropertyValue("--right-panel-composer-overlay-reserve") };
    });
    if (device.width === 390) {
      const old = await page.addStyleTag({ content: ".cloud-desktop-panel { height: 100% !important }" });
      await page.waitForTimeout(100); const negative = await geometry();
      assert.ok(negative.pad.bottom > negative.composerTop && negative.hits.some(hit => !hit), "old full-height panel must reproduce screenshot occlusion");
      evidence.push({ device, negative }); await old.evaluate(node => node.remove());
    }
    const check = async (label: string) => {
      await page.waitForTimeout(300); const g = await geometry();
      assert.ok(g.composerBottom <= g.visibleBottom + 1 && Math.abs(g.rootBottom - g.visibleBottom) < 1, JSON.stringify({ label, device, g }));
      assert.ok(g.pad.bottom <= g.composerTop + 1, JSON.stringify({ label, device, g }));
      assert.ok(g.toolbar.bottom <= g.pad.top + 1 && g.media.bottom <= g.toolbar.top + 1, JSON.stringify({ label, device, g }));
      assert.ok(g.media.height > 15 && g.pad.height >= 44, JSON.stringify({ label, device, g }));
      assert.ok(g.hits.every(Boolean), JSON.stringify({ label, device, g }));
      assert.ok(g.sameCanvas && g.sameEditor && g.connections === 1); assert.equal(await editor.innerText(), "Keep this draft");
      evidence.push({ device, label, geometry: g });
    };
    await check("default");
    const count = await page.evaluate(() => (window as any).fixture.packets.length);
    await pad.tap(); await page.waitForTimeout(50);
    assert.deepEqual(await page.evaluate(n => (window as any).fixture.packets.slice(n), count), [1, 0], "real touch hits pad through full Shell");
    // Real touch events reach document capture before the pad's bubbling stop.
    // Exercise nested hint text and held movement, not just final drawer state.
    const cdp = await context.newCDPSession(page);
    const sidebar = page.locator(".app-shell-floating-left-panel");
    await page.waitForTimeout(350); // Let the preceding tap's double-tap window expire.
    const heldBox = await pad.boundingBox(); assert.ok(heldBox);
    const heldPoint = { x: heldBox.x + heldBox.width / 2, y: heldBox.y + heldBox.height / 2, id: 1 };
    const packetCount = () => page.evaluate(() => (window as any).fixture.packets.length);
    const masksSince = (n: number) => page.evaluate(n => (window as any).fixture.packets.slice(n) as number[], n);
    const holdStart = await packetCount();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [heldPoint] });
    await page.waitForTimeout(100);
    assert.deepEqual(await masksSince(holdStart), [], "stationary hold must not press immediately");
    await page.waitForFunction(() => document.querySelector<HTMLElement>(".ui-desktop-trackpad__surface")?.dataset.pressed === "true");
    assert.deepEqual(await masksSince(holdStart), [1], "300ms hold grabs without a preceding tap");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...heldPoint, x: heldPoint.x + 35 }] });
    const heldMasks = await masksSince(holdStart);
    assert.ok(heldMasks.length >= 2 && heldMasks.every(mask => mask === 1), "movement keeps the button held");
    assert.equal(await sidebar.count(), 0, "held drag cannot reveal sidebar");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.deepEqual(await masksSince(holdStart), [...heldMasks, 0], "release ends drag without a second click");
    await page.waitForTimeout(350);
    const moveStart = await packetCount();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [heldPoint] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...heldPoint, x: heldPoint.x + 35 }] });
    await page.waitForTimeout(400);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const moveMasks = await masksSince(moveStart);
    assert.ok(moveMasks.length > 0 && moveMasks.every(mask => mask === 0), "moving then pausing cannot arm a long-press drag");
    const cancelStart = await packetCount();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [heldPoint] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await page.waitForTimeout(400);
    assert.deepEqual(await masksSince(cancelStart), [], "cancelled native touch cannot fire a delayed press");
    evidence.push({ device, longPress: { heldMasks, moveMasks, nativeCancel: true } });
    const gesture = async (from: number, to: number, y: number, pair = false) => {
      const points = (x: number) => [{ x, y, id: 1 }, ...(pair ? [{ x: x + 25, y: y + 16, id: 2 }] : [])];
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(from) });
      for (let i = 1; i <= 8; i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(from + (to - from) * i / 8) });
        await page.waitForTimeout(20);
        assert.equal(await sidebar.count(), 0, "trackpad gesture must never reveal sidebar while held");
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(350);
      assert.equal(await sidebar.count(), 0, "trackpad gesture must not settle sidebar open");
    };
    const hint = await pad.locator(".ui-desktop-trackpad__hint").boundingBox(); assert.ok(hint);
    const y = hint.y + hint.height / 2;
    const beforeMove = await page.evaluate(() => (window as any).fixture.packets.length);
    await gesture(65, device.width - 65, y);
    await gesture(device.width - 65, 65, y);
    assert.ok(await page.evaluate(n => (window as any).fixture.packets.slice(n).some((mask: number) => mask === 0), beforeMove), "pad still sends remote pointer moves");
    const beforeScroll = await page.evaluate(() => (window as any).fixture.packets.length);
    await gesture(65, device.width - 90, y, true);
    assert.ok(await page.evaluate(n => (window as any).fixture.packets.slice(n).some((mask: number) => mask === 32 || mask === 64), beforeScroll), "pad still sends two-finger horizontal scroll");
    await page.waitForTimeout(350); const beforeClick = await page.evaluate(() => (window as any).fixture.packets.length);
    await pad.tap();
    assert.deepEqual(await page.evaluate(n => (window as any).fixture.packets.slice(n), beforeClick), [1, 0], "pad tap remains single click after swipe");
    await check("sidebar-gesture-isolation");
    evidence.push({ device, sidebarGestureIsolation: true, nestedText: true, heldFrames: true, remoteMoveScrollTap: true });
    await page.screenshot({ path: `${output}/${device.width}-default.png` });
    await page.locator(".thread-composer-overlay__summary").tap();
    await page.locator('.cloud-desktop-panel[data-control="observing"]').waitFor();
    await page.getByRole("button", { name: "Take control", exact: true }).tap(); await pad.waitFor();
    await check("expanded-latest");
    await page.locator(".thread-composer-overlay__summary").tap();
    await page.getByRole("button", { name: "Take control", exact: true }).tap(); await pad.waitFor();
    // Synthetic visual viewport, same source as real Shell. No OS keyboard claim.
    for (const top of [0, 65, 0]) {
      await page.evaluate(([height, top]) => (window as any).setViewport(height, top), [Math.round(device.height * .60), top]);
      await check(`keyboard-${top}`);
    }
    await page.screenshot({ path: `${output}/${device.width}-keyboard.png` });
    await page.evaluate(h => (window as any).setViewport(h), device.height); await check("restored");
    await page.getByRole("button", { name: "Stop controlling", exact: true }).tap(); await pad.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Take control", exact: true }).tap(); await pad.waitFor(); await check("retake");
    // Closing fullscreen restores the same original chat editor and draft.
    await page.evaluate(() => (window as any).fixture.setPanelOpen(false));
    await editor.waitFor(); await page.waitForTimeout(200); assert.equal(await editor.innerText(), "Keep this draft");
    assert.equal(await editor.evaluate(node => node === (window as any).keptEditor), true);
    // Ordinary content still owns Shell's existing right-swipe reveal.
    const content = await page.getByText("Parent conversation", { exact: true }).boundingBox(); assert.ok(content);
    const contentY = content.y + Math.min(content.height / 2, 100);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 65, y: contentY, id: 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: device.width - 40, y: contentY, id: 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(650); assert.equal(await sidebar.count(), 1, "ordinary content still reveals sidebar");
    assert.deepEqual(errors, []); await context.close();
  }
  await writeFile(`${output}/result.json`, JSON.stringify({ evidence, boundary: "real Shell/Composer/Panel/input; external desktop media/grant synthetic; no native iPhone keyboard acceptance" }, null, 2));
  console.log(`PASS full Shell trackpad no-occlusion, native touch hit, latest turn, keyboard viewport, same media/editor/draft; ${output}`);
} catch (error) {
  if (activePage && !activePage.isClosed()) { await activePage.screenshot({ path: `${output}/failure.png` }); await writeFile(`${output}/failure.txt`, await activePage.locator("body").innerText()); }
  throw error;
} finally { await browser.close(); await server.close(); }
