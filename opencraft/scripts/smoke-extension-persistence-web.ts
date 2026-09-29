import assert from "node:assert/strict";
import { createServer } from "vite";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = await mkdtemp("/tmp/oc-extension-web-");
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", cacheDir: "node_modules/.vite-extension-persistence",
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "extension-persistence-fixture", configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url !== "/") return next();
    res.setHeader("Content-Type", "text/html"); res.end('<script type="module" src="/scripts/fixtures/extension-persistence.ts"></script>');
  }); } }],
});
let browser: any;
const evidence: string[] = [], errors: string[] = [];
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const context = await browser.newContext();
  const a = await context.newPage(), b = await context.newPage();
  const url = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}/`;
  for (const page of [a, b]) {
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(url); await page.waitForFunction(() => !!(window as any).extensionStorageProbe);
    await page.waitForFunction(() => (window as any).extensionStorageProbe.workerMessages() > 0);
  }
  const initial = await a.evaluate(() => (window as any).extensionStorageProbe.read());
  assert.equal((await a.evaluate(() => (window as any).extensionStorageProbe.legacySettings()))[0].value, true);
  evidence.push("real current-origin legacy IndexedDB settings imported through the production platform factory");
  await a.evaluate(({ revision }: any) => (window as any).extensionStorageProbe.save(revision, { text: "browser fixture" }), initial);
  await b.waitForFunction(() => (window as any).extensionStorageProbe.notifications() > 0);
  const stale = await b.evaluate(({ revision }: any) => (window as any).extensionStorageProbe.save(revision, { text: "stale" }), initial);
  assert.equal(stale.updated, false); assert.equal(stale.snapshot.value.text, "browser fixture");
  evidence.push("two real Chromium tabs: durable CAS conflict and post-commit cross-tab notification");
  await a.reload(); await a.waitForFunction(() => !!(window as any).extensionStorageProbe);
  assert.equal((await a.evaluate(() => (window as any).extensionStorageProbe.read())).value.text, "browser fixture");
  await a.evaluate(() => (window as any).extensionStorageProbe.upgrade());
  assert.equal(await a.evaluate(() => (window as any).extensionStorageProbe.workerDisposed()), true);
  assert.equal((await a.evaluate(() => (window as any).extensionStorageProbe.read())).value.upgraded, true);
  assert.equal(await b.evaluate(async () => { try { await (window as any).extensionStorageProbe.read(); return false; } catch { return true; } }), true);
  evidence.push("Cordis hot reload disposes actual Worker; pure payload upgrade persists; older activation refuses newer data");
  await a.evaluate(async () => {
    await (window as any).extensionStorageProbe.stop();
    await new Promise<void>((resolve, reject) => { const request = indexedDB.open("fixture-vela-extension-data", 2); request.onsuccess = () => { request.result.close(); resolve(); }; request.onerror = () => reject(request.error); });
  });
  assert.equal(await b.evaluate(async () => { try { await (window as any).extensionStorageProbe.read(); return false; } catch { return true; } }), true);
  evidence.push("native IndexedDB versionchange closes both old connections; no automatic deletion or reload");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ output, evidence }, null, 2));
} finally { await writeFile(join(output, "report.json"), JSON.stringify({ evidence, errors }, null, 2)); await browser?.close(); await vite.close(); }
