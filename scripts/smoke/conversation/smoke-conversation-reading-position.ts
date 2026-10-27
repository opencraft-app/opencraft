import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_READING_OUTPUT ?? ".local/conversation-reading-position";
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-reading-position", server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "reading-position", configureServer(vite) { vite.middlewares.use((req, res, next) => { if (!req.url?.startsWith("/?")) return next(); res.setHeader("content-type", "text/html"); res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/conversation-reading-position.tsx"></script>'); }); } }] });
let browser: any;
const records: unknown[] = [];
try {
 await server.listen();
 browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
 for (const width of [390, 1200]) for (const theme of ["light", "dark"]) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width === 390, reducedMotion: "reduce" });
  await context.addInitScript(() => { (window as any).__name = (fn: unknown) => fn; });
  const page = await context.newPage(); const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
  try {
   await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port: number}).port}/?theme=${theme}`);
   const invoke = async (method: string, ...args: unknown[]) => { await page.evaluate(([method, args]: any[]) => (window as any).readerFixture[method](...args), [method, args]); };
   const ready = async () => { await page.waitForFunction(() => document.querySelectorAll(".chat-code-block__scroller").length === 2 && !!document.querySelector(".chat-table-scroller")); await page.waitForTimeout(180); };
   const offsets = async () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".chat-code-block__scroller,.chat-table-scroller")].map(e => e.scrollLeft));
   const scroll = async (values: number[]) => page.evaluate((values: number[]) => [...document.querySelectorAll<HTMLElement>(".chat-code-block__scroller,.chat-table-scroller")].forEach((e, i) => { e.scrollLeft = values[i]; }), values);
   const hide = async () => { await invoke("hide"); await page.locator(".thread-scroll").waitFor({ state: "detached" }); };
   const show = async (scope = "A", fresh = false) => {
    await page.evaluate(() => { const w = window as any; w.__firstReadingFrame = null; function sample() { const els = [...document.querySelectorAll<HTMLElement>(".chat-code-block__scroller,.chat-table-scroller")]; if(els.length === 3) { w.__firstReadingFrame = els.map(e => e.scrollLeft); return; } requestAnimationFrame(sample); } requestAnimationFrame(sample); });
    await invoke("show", scope, fresh); await ready();
   };
   await ready(); await invoke("theme", theme); await scroll([160, 80, 140]); await page.waitForTimeout(40); assert.deepEqual(await offsets(), [160, 80, 140]);
   await hide(); await show(); assert.deepEqual(await offsets(), [160, 80, 140], "same Conversation View restores each block independently"); assert.deepEqual(await page.evaluate(() => (window as any).__firstReadingFrame), [160, 80, 140], "first painted restored frame has its reading positions");
   // A native scroll event is still queued when React tears the View down.
   await page.evaluate(() => { [...document.querySelectorAll<HTMLElement>(".chat-code-block__scroller,.chat-table-scroller")].forEach((e, i) => { e.scrollLeft = [175, 95, 155][i]; }); (window as any).readerFixture.hide(); });
   await page.locator(".thread-scroll").waitFor({ state: "detached" }); await show(); assert.deepEqual(await offsets(), [175, 95, 155], "layout teardown captures live offsets before refs detach");
   const code = await page.locator(".chat-code-block__scroller").first().elementHandle(); await page.locator("[data-focus-guard]").focus(); await invoke("append"); await ready(); assert.ok(await code!.evaluate(e => e.isConnected)); assert.deepEqual(await offsets(), [175, 95, 155]); assert.equal(await page.locator("[data-focus-guard]").evaluate((e: HTMLElement) => e === document.activeElement), true);
   await invoke("theme", theme === "light" ? "dark" : "light"); await ready(); assert.deepEqual(await offsets(), [175, 95, 155]);
   await hide(); await invoke("append"); await show(); assert.deepEqual(await offsets(), [175, 95, 155], "source append during absence preserves reading");
   await hide(); await show("B"); assert.deepEqual(await offsets(), [0, 0, 0], "other Conversation is isolated"); await scroll([40, 60, 70]); await hide(); await show("A"); assert.deepEqual(await offsets(), [175, 95, 155]);
   await hide(); await invoke("replace"); await show(); assert.equal((await offsets())[0], 0, "replaced code never consumes the old source position");
   await hide(); await show("A", true); assert.deepEqual(await offsets(), [0, 0, 0], "fresh View starts at origin");
   assert.deepEqual(errors, []); await page.screenshot({path: `${output}/${width}-${theme}.png`}); records.push({width, theme, passed: true, errors});
  } catch (error) { await page.screenshot({path: `${output}/failure-${width}-${theme}.png`}); throw error; } finally { await context.close(); }
 }
 console.log(JSON.stringify({passed: true, cases: records.length}));
} finally { await writeFile(`${output}/results.json`, JSON.stringify(records, null, 2)); await browser?.close(); await server.close(); }
