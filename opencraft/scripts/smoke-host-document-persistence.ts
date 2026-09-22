import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { startLocalAgentHost } from "../apps/local-agent-host/src/main.ts";
import { startDocumentTestEngine } from "./support/host-document-fixture.ts";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const root = await mkdtemp("/tmp/oc-host-storage-web-");
const engine = await startDocumentTestEngine();
let a = await startLocalAgentHost({ dshUrl: engine.url, dataDirectory: join(root, "a") });
const b = await startLocalAgentHost({ dshUrl: engine.url, dataDirectory: join(root, "b") });
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", cacheDir: "node_modules/.vite-host-documents",
  server: { host: "127.0.0.1", port: 0, hmr: false }, plugins: [{ name: "host-document-fixture", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url === "/fixture-hosts") {
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ a: a.websocketUrl, b: b.websocketUrl })); return;
      }
      if (request.url !== "/") return next();
      response.setHeader("Content-Type", "text/html"); response.end('<script type="module" src="/scripts/fixtures/host-document-persistence.ts"></script>');
    });
  } }] });
let browser: any;
const evidence: string[] = [];
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const context = await browser.newContext(), first = await context.newPage(), second = await context.newPage();
  for (const page of [first, second]) {
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/`);
    await page.waitForFunction(() => !!(window as any).hostDocumentProbe);
  }
  const initial = await first.evaluate(() => (window as any).hostDocumentProbe.read("a"));
  await first.evaluate((revision: number) => (window as any).hostDocumentProbe.save("a", revision, { saved: "remote fixture" }), initial.revision);
  await second.waitForFunction(() => (window as any).hostDocumentProbe.changes() > 0);
  const conflict = await second.evaluate((revision: number) => (window as any).hostDocumentProbe.save("a", revision, { saved: "stale" }), initial.revision);
  assert.equal(conflict.updated, false); assert.equal(conflict.snapshot.value.saved, "remote fixture");
  assert.deepEqual((await first.evaluate(() => (window as any).hostDocumentProbe.read("b"))).value, {});
  assert.equal(await first.evaluate(() => (window as any).hostDocumentProbe.local()), null);
  evidence.push("two real browser tabs -> SDK -> actual authenticated Host -> SQLite: CAS, notifications and Host A/B isolation");
  await a.close();
  assert.equal(await first.evaluate(async () => { try { await (window as any).hostDocumentProbe.read("a"); return false; } catch { return true; } }), true);
  assert.equal(await first.evaluate(() => (window as any).hostDocumentProbe.local()), null);
  a = await startLocalAgentHost({ dshUrl: engine.url, dataDirectory: join(root, "a") });
  await first.evaluate(() => (window as any).hostDocumentProbe.reconnect("a"));
  assert.equal((await first.evaluate(() => (window as any).hostDocumentProbe.read("a"))).value.saved, "remote fixture");
  assert.equal(await second.evaluate(async () => { try { await (window as any).hostDocumentProbe.read("a"); return false; } catch { return true; } }), true);
  evidence.push("Host stopped: old handles fail with no local fallback; explicit reconnect after restart reads the same durable record");
  console.log(JSON.stringify({ root, evidence }, null, 2));
} finally { await writeFile(join(root, "report.json"), JSON.stringify({ evidence }, null, 2)); await browser?.close(); await vite.close(); await a.close(); await b.close(); await engine.close(); }
