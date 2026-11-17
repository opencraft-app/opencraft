import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright") as typeof import("@playwright/test");
const scope = "/servers/fixture/";
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/offline-startup-continuity";
const runtime = (await build({ entryPoints: ["apps/workbench-web/src/runtime/offline-shell.ts"], bundle: true, format: "esm", write: false })).outputFiles[0].text;
const worker = (await readFile("apps/workbench-web/offline-shell-worker.js", "utf8"))
  .replace('"__OPENCRAFT_BUILD__"', '"continuity"')
  .replace('"__OPENCRAFT_FILES__"', JSON.stringify(["assets/main-ABC12345.js", "opencraft-offline.html"]));
const started = Date.now();
const requests: { path: string; elapsed: number }[] = [];
const server = createServer((request, response) => {
  const path = new URL(request.url!, "http://localhost").pathname;
  requests.push({ path, elapsed: Date.now() - started });
  response.setHeader("cache-control", "no-store");
  if (path === scope + "opencraft-app-sw.js") {
    response.setHeader("content-type", "text/javascript"); response.end(worker); return;
  }
  if (path === scope + "runtime.js") {
    response.setHeader("content-type", "text/javascript"); response.end(runtime); return;
  }
  if (path === scope + "assets/main-ABC12345.js") {
    response.setHeader("content-type", "text/javascript"); response.end("// public artifact"); return;
  }
  response.setHeader("content-type", "text/html");
  if (path === scope + "opencraft-offline.html") {
    response.end('<!doctype html><html><head></head><body><main>Complete offline shell</main></body></html>'); return;
  }
  if (path === scope + "threads/stalled") {
    response.writeHead(200); response.write("<!doctype html><html><head>"); return;
  }
  if (path === scope + "settings/denied") { response.writeHead(403); response.end("Explicit refusal"); return; }
  if (path === scope) {
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="opencraft-build-id" content="continuity"><meta name="opencraft-browser-backend" content="iframe"><script id="opencraft-server-context" type="application/json">{"id":"fixture","name":"Fixture","selectorPath":"/servers","basePath":"/servers/fixture"}</script></head><body><textarea aria-label="Draft"></textarea><script type="module">import { prepareOfflineShell } from './runtime.js'; const owner = new AbortController(); window.addEventListener('pagehide', () => owner.abort(), {once:true}); window.preparationStarted = Date.now(); prepareOfflineShell(owner.signal).catch(error => { if (!owner.signal.aborted) window.preparationFailure = error.message; });</script></body></html>`); return;
  }
  response.writeHead(404); response.end("Outside offline navigation scope");
});
let browser: import("@playwright/test").Browser | undefined;
try {
  await mkdir(output, { recursive: true });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const touch of [false, true]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1200, height: 844 }, hasTouch: touch, isMobile: touch });
    try {
      const page = await context.newPage(); const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(origin + scope);
      await page.waitForFunction(() => (window as any).preparationStarted !== undefined);
      const workerCount = requests.filter(row => row.path === scope + "opencraft-app-sw.js").length;
      await page.getByRole("textbox", { name: "Draft" }).fill("Opening stays usable before optional warming");
      assert.equal(requests.filter(row => row.path === scope + "opencraft-app-sw.js").length, workerCount);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.offlineReady), undefined);
      await page.waitForFunction(() => document.documentElement.dataset.offlineReady === "continuity", null, { timeout: 30_000 });
      assert.ok(await page.evaluate(() => Date.now() - (window as any).preparationStarted >= 10_000));
      assert.equal(await page.getByRole("textbox").inputValue(), "Opening stays usable before optional warming");
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
      const began = Date.now();
      const navigation = await page.goto(origin + scope + "threads/stalled", { timeout: 20_000 });
      assert.equal(navigation?.headers()["x-opencraft-offline-build"], "continuity");
      assert.ok(Date.now() - began >= 7_500, "real eight-second navigation deadline");
      await page.getByRole("main").filter({ hasText: "Complete offline shell" }).waitFor();
      assert.equal(await page.locator('meta[name="opencraft-browser-backend"]').getAttribute("content"), "iframe");
      const denied = await page.goto(origin + scope + "settings/denied");
      assert.equal(denied?.status(), 403); assert.equal(await page.locator("body").textContent(), "Explicit refusal");
      assert.equal(denied?.headers()["x-opencraft-offline-build"], undefined);
      assert.deepEqual(errors, []);
      console.log(`PASS offline startup/navigation: ${touch ? "touch" : "desktop"}, real SW, delayed warming, stalled body, denial`);
    } finally { await context.close(); }
  }
  await writeFile(output + "/requests.json", JSON.stringify(requests, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
