import { WebSocketServer } from "ws";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";

const socketServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise<void>(resolve => socketServer.once("listening", resolve));
const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/upload-progress");
await mkdir(output, { recursive: true });
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
 resolve: { dedupe: ["react", "react-dom"] }, server: { host: "127.0.0.1", port: 0 },
 plugins: [{ name: "upload-fixture", configureServer(server) { server.middlewares.use((req, res, next) => {
  if (req.url !== "/") return next();
  res.setHeader("content-type", "text/html");
  res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/composer-upload-progress.tsx"></script>');
 }); } }] });
const profile = await mkdtemp(join(tmpdir(), "upload-progress-"));
await writeFile(join(profile, "app.cjs"), 'const {app,BrowserWindow}=require("electron");app.setPath("userData",__dirname);app.whenReady().then(()=>new BrowserWindow({show:true,width:390,height:844}).loadURL("about:blank"));');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.DISPLAY;
await vite.listen(); console.log("Vite ready");
const browser = await _electron.launch({ executablePath: process.env.OPENCRAFT_ELECTRON_EXECUTABLE ?? "/opt/opencraft/runtime/browser/electron/electron",
 args: ["--ozone-platform=headless", "--ozone-override-screen-size=1600,1200", "--disable-dev-shm-usage", "--disable-gpu", join(profile, "app.cjs")], env });
try {
 console.log("Electron ready"); const page = await browser.firstWindow(); page.setDefaultTimeout(15000); const errors: string[] = [];
 page.on("pageerror", e => errors.push(e.message));
 await page.goto(vite.resolvedUrls!.local[0]!, { waitUntil: "domcontentloaded" }); console.log("Page loaded");
 await page.locator(".opencraft-composer-editor").waitFor(); console.log("Composer ready");
 const cdp = await page.context().newCDPSession(page);
 for (const width of [390, 1280]) {
  await page.setViewportSize({ width, height: 700 });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: width === 390 });
  await page.evaluate(w => { document.documentElement.dataset.uiDensity = w === 390 ? "touch" : "compact"; }, width);
  await page.evaluate(() => (window as any).add());
  const file = page.locator(".opencraft-composer-attachment"), image = page.locator(".opencraft-composer-image-attachment");
  await file.waitFor(); await image.waitFor(); console.log("Attachments ready", width);
  const bounds = { file: await file.boundingBox(), image: await image.boundingBox() };
  assert.equal(await file.locator('[role="progressbar"]').getAttribute("aria-valuenow"), null);
  await page.evaluate(async () => {
    (window as any).report("report.pdf", 0);
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
  });
  await page.evaluate(() => (window as any).report("report.pdf", 4096));
  await page.waitForFunction(() => document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow") === "50");
  assert.notEqual(await file.locator(".ui-progress-indicator circle").last().evaluate(e => getComputedStyle(e).transitionDuration), "0s");
  assert.equal(await file.locator(".ui-progress-indicator").evaluate(e => getComputedStyle(e).animationName), "none");
  await page.evaluate(() => (window as any).report("report.pdf", null));
  await page.waitForFunction(() => document.querySelector(".opencraft-composer-attachment .ui-progress-indicator")!.getAnimations().some(a => a.playState === "running"));
  await page.evaluate(() => (window as any).report("report.pdf", 4096));
  await page.waitForFunction(() => document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow") === "50");
  const centers = await file.locator(".opencraft-composer-attachment__icon").evaluate(e => {
   const icon = e.getBoundingClientRect(), ring = e.querySelector(".ui-progress-indicator")!.getBoundingClientRect();
   return Math.abs(icon.x + icon.width / 2 - ring.x - ring.width / 2);
  }); assert(centers < 1);
  for (const mode of ["light", "dark"]) for (const palette of ["neutral", "frost"]) {
   await page.evaluate(({ mode, palette }) => (window as any).theme(mode, palette), { mode, palette });
   assert.equal(await image.locator(".ui-progress-indicator").evaluate(e => getComputedStyle(e).animationName), "ui-progress-rotate");
   await page.screenshot({ path: join(output, width + "-" + mode + "-" + palette + ".png") });
  }
  await page.evaluate(() => (window as any).report("photo.svg", 4096));
  await page.waitForFunction(() => document.querySelector(".opencraft-composer-image-attachment__percent")?.textContent === "50%");
  assert.equal(await image.getByRole("progressbar").getAttribute("aria-valuenow"), "50");
  await page.evaluate(() => (window as any).report("photo.svg", null));
  await page.waitForFunction(() => document.querySelector(".opencraft-composer-image-attachment .ui-progress-indicator")!.getAnimations().some(a => a.playState === "running"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => document.querySelector(".opencraft-composer-image-attachment .ui-progress-indicator")!.getAnimations().length === 0);
  assert(parseFloat(await file.locator(".ui-progress-indicator circle").last().evaluate(e => getComputedStyle(e).transitionDuration)) <= 0.001);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => (window as any).report("report.pdf", 8192, "sent"));
  await file.getByText("Processing…", { exact: true }).waitFor();
  assert.equal(await file.getAttribute("data-state"), "uploading");
  assert.equal(await file.getByRole("progressbar").getAttribute("aria-valuenow"), "100");
  assert.deepEqual(await file.boundingBox(), bounds.file);
  await page.screenshot({ path: join(output, width + "-awaiting-confirmation.png") });
  await page.evaluate(() => (window as any).fail("photo.svg"));
  const retry = image.getByRole("button", { name: /^Retry/ }); await retry.waitFor();
  assert.deepEqual(await image.boundingBox(), bounds.image);
  if (width === 390) {
   const box = (await retry.boundingBox())!;
   await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
   await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else { await retry.focus(); await page.keyboard.press("Enter"); }
  await image.locator(".ui-progress-indicator").waitFor();
  // Real browser WebSocket counter; server deliberately withholds confirmation.
  const received = new Promise<import("ws").WebSocket>(resolve => socketServer.once("connection", socket => {
    socket.once("message", bytes => { assert.equal(bytes.length, 1024 * 1024); resolve(socket); });
  }));
  await page.evaluate(url => {
    (window as any).report("report.pdf", null);
    (window as any).startSocketUpload(url);
  }, "ws://127.0.0.1:" + (socketServer.address() as import("node:net").AddressInfo).port);
  const receiver = await received;
  await file.getByText("Processing…", { exact: true }).waitFor();
  assert.equal(await file.getAttribute("data-state"), "uploading", "queue drain never commits readiness");
  receiver.send("committed");
  await page.waitForFunction(() => document.querySelector(".opencraft-composer-attachment")?.getAttribute("data-state") === "ready");
  await page.evaluate(() => (window as any).finish("photo.svg"));
  await page.waitForFunction(() => document.querySelectorAll(".opencraft-composer-attachments .ui-progress-indicator").length === 0);
  assert.deepEqual(await file.boundingBox(), bounds.file);
  assert.deepEqual(await image.boundingBox(), bounds.image);
  await file.getByRole("button", { name: /^Remove/ }).click();
  await image.getByRole("button", { name: /^Remove/ }).click();
 }
 assert.deepEqual(errors, []);
 console.log("PASS actual composer: progress, stable geometry, theme, reduced motion, touch/keyboard retry and completion");
} finally { await browser.close(); await vite.close(); await new Promise<void>(resolve => socketServer.close(() => resolve())); }
