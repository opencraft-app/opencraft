import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";

const output = process.env.OPENCRAFT_TRACKPAD_OUTPUT ?? ".local/preview-trackpad";
await mkdir(output, { recursive: true });
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "preview-trackpad-fixture",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<!doctype html><style>*{box-sizing:border-box}body{margin:0;background:#eee}</style><div id="root"></div><script type="module" src="/tests/fixtures/preview-trackpad.tsx"></script>',
          );
        });
      },
    },
  ],
});
await vite.listen();
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
  ...(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
  const outsideWheel = (ctrlKey: boolean) =>
    page.locator("body").evaluate((element, ctrlKey) => {
      const event = new WheelEvent("wheel", { deltaY: -100, ctrlKey, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }, ctrlKey);
  assert.equal(await outsideWheel(true), true, "pinch outside a viewport cannot zoom the page");
  assert.equal(await outsideWheel(false), false, "ordinary scrolling is retained");
  const stage = page.locator(".opencraft-zoomable-image");
  await stage.locator("img").evaluate(async (img: HTMLImageElement) => img.decode());
  await page.waitForTimeout(100);
  const matrix = () =>
    stage.locator("img").evaluate((element) => {
      const m = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return { scale: Math.hypot(m.a, m.b), angle: Math.atan2(m.b, m.a), x: m.e, y: m.f };
    });
  const wheel = (deltaX: number, deltaY: number, ctrlKey = false) =>
    stage.evaluate(
      (element, value) => {
        const box = element.getBoundingClientRect();
        const event = new WheelEvent("wheel", {
          ...value,
          clientX: box.x + box.width * 0.6,
          clientY: box.y + box.height * 0.6,
          bubbles: true,
          cancelable: true,
        });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      },
      { deltaX, deltaY, ctrlKey },
    );
  assert.equal(await wheel(0, -Math.log(3) / 0.01, true), true);
  assert.ok(Math.abs((await matrix()).scale - Math.E) < 0.01, "pinch delta is capped per event");
  await wheel(0, -Math.log(3 / Math.E) / 0.01, true);
  assert.ok(Math.abs((await matrix()).scale - 3) < 0.01);
  const before = await matrix();
  await wheel(-45, -35);
  const after = await matrix();
  assert.ok(
    Math.abs(after.x - before.x - 45) < 0.01 && Math.abs(after.y - before.y - 35) < 0.01,
    "two-axis trackpad pan",
  );
  assert.equal(await page.evaluate(() => scrollY), 0, "preview gesture must not scroll the page");
  await stage.hover();
  await page.evaluate(() => (window as any).rotateTrackpad(90));
  assert.ok(
    Math.abs((await matrix()).angle + Math.PI / 2) < 0.001,
    "AppKit counter-clockwise delta maps to CSS rotation",
  );
  const rotated = await matrix();
  await page.evaluate(() => (window as any).rotateTrackpad(0));
  assert.deepEqual(await matrix(), rotated, "native end marker must not reset rotation");
  await page.mouse.move(950, 750);
  await page.evaluate(() => (window as any).rotateTrackpad(45));
  assert.deepEqual(await matrix(), rotated, "rotation outside the preview is ignored");
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await stage.locator("img").evaluate(async (img: HTMLImageElement) => img.decode());
  await page.waitForTimeout(100);
  assert.deepEqual(await matrix(), { scale: 1, angle: 0, x: 0, y: 0 });
  assert.equal(
    await page.evaluate(() => (window as any).rotationSubscriptions()),
    1,
    "remount must release the old native listener",
  );
  for (const [name, scale, rotation] of [
    ["gesturestart", 1, 0],
    ["gesturechange", 2, 30],
    ["gestureend", 2, 30],
  ] as const) {
    await stage.evaluate(
      (element, detail) => {
        const box = element.getBoundingClientRect();
        const event = Object.assign(new Event(detail.name, { bubbles: true, cancelable: true }), {
          scale: detail.scale,
          rotation: detail.rotation,
          clientX: box.x + box.width / 2,
          clientY: box.y + box.height / 2,
        });
        element.dispatchEvent(event);
      },
      { name, scale, rotation },
    );
  }
  const safari = await matrix();
  assert.ok(
    Math.abs(safari.scale - 2) < 0.001 && Math.abs(safari.angle - Math.PI / 6) < 0.001,
    "Safari cumulative scale and rotation",
  );
  await page.screenshot({ path: `${output}/trackpad-rotated.png` });
  await page.getByRole("button", { name: "Toggle" }).click();
  assert.equal(await page.evaluate(() => (window as any).rotationSubscriptions()), 0);
  const cdp = await page.context().newCDPSession(page);
  const viewport = () => page.evaluate(() => ({ scale: visualViewport?.scale ?? 1, dpr: devicePixelRatio }));
  const beforePinch = await viewport();
  const pinch = () =>
    cdp.send("Input.synthesizePinchGesture", {
      x: 900,
      y: 600,
      scaleFactor: 1.6,
      relativeSpeed: 800,
      gestureSourceType: "mouse",
    });
  await pinch();
  assert.deepEqual(await viewport(), beforePinch, "native touchpad pinch leaves the whole page at its original scale");
  await page.evaluate(() => (window as any).releaseInputRuntime());
  assert.equal(await outsideWheel(true), false, "document retirement releases the guard");
  await pinch();
  assert.ok(
    (await viewport()).scale > beforePinch.scale || (await viewport()).dpr > beforePinch.dpr,
    "negative control: without the guard the same browser input zooms the page",
  );
  await cdp.detach();
  console.log("Whole-page pinch blocked; without the guard the same native browser input zooms the page.");
  assert.deepEqual(errors, []);
  console.log("Trackpad pan, pinch, Safari rotation, native rotation, bounds and cleanup passed.");
} finally {
  await browser.close();
  await vite.close();
}
