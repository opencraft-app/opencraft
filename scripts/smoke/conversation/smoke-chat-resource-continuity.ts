import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { _electron } from "playwright-core";

const output = resolve(process.env.OPENCRAFT_RESOURCE_CONTINUITY_OUTPUT ?? ".local/chat-resource-continuity");
const root = await mkdtemp(join(tmpdir(), "chat-resource-continuity-"));
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-resource-continuity", server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "resource-continuity", configureServer(vite) { vite.middlewares.use((req, res, next) => {
  if (req.url !== "/") return next();
  res.setHeader("content-type", "text/html");
  res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/chat-resource-continuity.tsx"></script>');
}); } }] });
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
const results: unknown[] = [];
try {
  await server.listen();
  const script = join(root, "app.cjs");
  await writeFile(script, "const{app,BrowserWindow}=require('electron');app.setPath('userData',require('node:path').join(__dirname,'profile'));app.whenReady().then(()=>new BrowserWindow({show:true,webPreferences:{sandbox:true}}).loadURL('about:blank'));");
  const env = { ...process.env };
  for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH", "DISPLAY", "WAYLAND_DISPLAY"]) delete env[key];
  app = await _electron.launch({ executablePath: process.env.OPENCRAFT_ELECTRON_EXECUTABLE, args: ["--ozone-platform=headless", "--ozone-override-screen-size=1920,1080", "--disable-gpu", "--disable-dev-shm-usage", script], env });
  const page = await app.firstWindow();
  await page.addInitScript(() => { (window as any).__name = (fn: unknown) => fn; });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const cdp = await page.context().newCDPSession(page);
  const call = (name: string, ...args: unknown[]) => page.evaluate(([name, args]: any[]) => (window as any).resourceFixture[name](...args), [name, args]);
  const ready = () => page.waitForFunction(() => document.querySelector(".chat-code-highlight") && document.querySelector(".katex") && (document.querySelector(".chat-markdown-image") as HTMLImageElement)?.complete && (document.querySelector("iframe") as HTMLIFrameElement)?.style.height === "100px");
  for (const width of [390, 1200]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 1000 });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: width === 390, maxTouchPoints: 5 });
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/`);
    await page.waitForFunction(() => !!(window as any).resourceFixture);
    await call("theme", theme); await ready();
    const inspect = () => call("inspect");
    const original = await inspect();
    await call("refresh"); await call("append");
    await page.waitForTimeout(200);
    assert.equal((await inspect()).reads, original.reads, "callback/source append must not reload an unchanged image");
    const height = await page.locator(".opencraft-chat-document").evaluate(e => e.getBoundingClientRect().height);
    await call("delay", 400); await call("hide");
    await page.locator(".opencraft-chat-document").waitFor({ state: "detached" });
    await page.evaluate(() => {
      const w = window as any; w.resourceFrames = []; w.recordResources = true;
      const sample = () => {
        if (!w.recordResources) return;
        const root = document.querySelector(".opencraft-chat-document");
        if (root) w.resourceFrames.push({ height: root.getBoundingClientRect().height, mathFallback: !!root.querySelector(".chat-math-fallback"), highlighted: !!root.querySelector(".chat-code-highlight") });
        requestAnimationFrame(sample);
      }; requestAnimationFrame(sample);
    });
    await call("show"); await ready(); await call("evict"); await page.waitForTimeout(300);
    const frames = await page.evaluate(() => { (window as any).recordResources = false; return (window as any).resourceFrames; });
    assert.ok(frames.length > 2);
    assert.ok(frames.every((f: any) => f.highlighted && !f.mathFallback), "warm output is final from its first frame");
    assert.ok(frames.every((f: any) => Math.abs(f.height - height) <= 2), "pending resource leases preserve measured geometry");
    await call("hide"); await page.locator(".opencraft-chat-document").waitFor({ state: "detached" });
    const released = await inspect();
    assert.equal(released.reads, released.releases, "unmount releases every media lease");
    assert.deepEqual(errors, []);
    await call("delay", 0); await call("show"); await ready();
    await page.screenshot({ path: join(output, `${width}-${theme}.png`) });
    results.push({ width, theme, frames, passed: true });
  }
  console.log(JSON.stringify({ passed: true, cases: results.length }));
} finally {
  await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2));
  await app?.close(); await server.close(); await rm(root, { recursive: true, force: true });
}
