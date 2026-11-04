import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";
import { ThreadCatalog } from "../../../apps/local-agent-host/src/thread-catalog.js";
import { CATALOG_MERKLE_CURSOR, isCatalogSnapshotHead } from "@opencraft/appserver-protocol";

const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/opencraft-catalog-merkle";
const store = new ThreadCatalog(), events: any[] = [];
const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `t${i}`, cwd: "/synthetic", createdAt: 1, updatedAt: 2000 - i,
  name: `Thread ${i}`, preview: "", status: { type: "idle" }, ephemeral: false, turns: [] }));
const directory = store.createProjection({ list: async p => ({ data: p.archived ? [] : rows, nextCursor: null }), changed: e => { if (e) events.push(e); } });
await directory.refresh();
const wire: Array<{ mode: string; rows: number; bytes: number }> = [];
let afterHead: (() => Promise<void>) | undefined;
const vite = await createServer({ configFile: false, root: process.cwd(), resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-catalog-merkle", optimizeDeps: { entries: ["tests/fixtures/catalog-entry-browser.tsx"] }, esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "merkle-catalog", configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      try {
        if (req.url?.split("?")[0] === "/") { res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/catalog-entry-browser.tsx"></script>'); return; }
        if (req.url?.split("?")[0] !== "/catalog-page") return next();
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const params = JSON.parse(Buffer.concat(chunks).toString());
        const page = await directory.list({ ...params, sortKey: "updated_at" });
        if (isCatalogSnapshotHead(params.cursor)) Object.assign(page, { catalogDecorations: { pins: [{ ...rows[120], name: "stale pin name" }] } });
        const body = JSON.stringify(page);
        wire.push({ mode: (page as any).catalogMerkle?.mode ?? "snapshot", rows: page.data.length, bytes: Buffer.byteLength(body) });
        if (params.cursor.startsWith(CATALOG_MERKLE_CURSOR) && isCatalogSnapshotHead(params.cursor) && afterHead) {
          const run = afterHead; afterHead = undefined; await run();
        }
        res.setHeader("content-type", "application/json"); res.end(body);
      } catch (error) { console.error(error); res.statusCode = 500; res.end("{}"); }
    });
  } }] });
let browser: any;
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.addInitScript("window.__name=value=>value");
  const url = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}/?versioned=1&merkle=1&theme=dark`;
  const settled = () => page.waitForFunction(() => { const e = (window as any).catalogEntry, s = e?.snapshot(); return s && s.status === "success" && !s.fetching && !s.partial; });
  await page.goto(url); await settled(); await page.evaluate(() => (window as any).catalogEntry.persisted());
  const initial = [...wire]; assert.equal(initial.reduce((n, p) => n + p.rows, 0), 1000);
  directory.observe("thread/name/updated", { threadId: "t1", name: "Recovered title" });
  directory.observe("thread/deleted", { threadId: "t9" });
  wire.length = 0;
  // A page reload discards the JS QueryClient and keeps only scoped IndexedDB.
  await page.reload(); await settled();
  let displayed = await page.evaluate(() => (window as any).catalogEntry.displayed());
  assert.equal(displayed.length, 999); assert.equal(displayed.find((r: any) => r.id === "t1").name, "Recovered title");
  assert.equal(displayed.some((r: any) => r.id === "t9"), false);
  assert.equal(displayed.find((r: any) => r.id === "t120").name, "Thread 120");
  const recovery = [...wire]; assert.ok(recovery.every(p => p.mode !== "snapshot"), JSON.stringify({ recovery, replica: await page.evaluate(() => (window as any).catalogEntry.replica()) }));
  assert.ok(recovery.reduce((n, p) => n + p.rows, 0) < 40);
  await page.evaluate(() => (window as any).catalogEntry.persisted()); wire.length = 0;
  await page.evaluate(() => (window as any).catalogEntry.refresh()); await settled();
  assert.deepEqual(wire.map(p => p.mode), ["equal"]); assert.equal(wire[0]!.rows, 0);
  const equal = [...wire];
  directory.observe("thread/name/updated", { threadId: "t2", name: "Snapshot title" });
  afterHead = async () => {
    directory.observe("thread/name/updated", { threadId: "t2", name: "Live title" });
    await page.evaluate((e: any) => (window as any).catalogEntry.event({ method: "opencraft/thread-catalog/changed", params: e }), events.at(-1));
  };
  await page.evaluate(() => (window as any).catalogEntry.refresh()); await settled();
  displayed = await page.evaluate(() => (window as any).catalogEntry.displayed());
  assert.equal(displayed.find((r: any) => r.id === "t2").name, "Live title");
  await page.screenshot({ path: output + "/recovered-touch-dark.png" });
  assert.deepEqual(errors, []);
  const report = { scope: "Chromium touch Sidebar/hooks + real ThreadDirectory + IndexedDB reopen; synthetic records, not a physical phone",
    initial, recovery, equal, finalCount: displayed.length, duringReadLiveTitle: true, errors };
  await writeFile(output + "/results.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ initialRequests: initial.length, recoveryRequests: recovery.length,
    initialBytes: initial.reduce((n, p) => n + p.bytes, 0), recoveryBytes: recovery.reduce((n, p) => n + p.bytes, 0),
    transferredRows: recovery.reduce((n, p) => n + p.rows, 0), errors }));
  await context.close();
} finally { if (browser) await browser.close(); await vite.close(); store.close(); }
