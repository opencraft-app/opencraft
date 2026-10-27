import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import WebSocket from "ws";
const output = process.env.OPENCRAFT_CATALOG_ENTRY_OUTPUT ?? '/tmp/opencraft-catalog-entry';
const nativeSocket = process.env.OPENCRAFT_CATALOG_NATIVE_SOCKET;
const pairedReplay = nativeSocket && process.env.OPENCRAFT_CATALOG_PAIRED_REPLAY === 'true';
let replay: Map<string | null, { page: any; ms: number }> | undefined;
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
let sequence = 0;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let native: WebSocket | undefined;
async function rpc(method: 'initialize' | 'thread/list', params: unknown) {
  return new Promise<any>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native read timeout')); }, 45_000);
    pending.set(id, { resolve, reject, timer }); native!.send(JSON.stringify({ id, method, params }));
  });
}
if (nativeSocket) {
  native = new WebSocket(`ws+unix://${nativeSocket}:/`);
  native.on('message', raw => { const frame = JSON.parse(String(raw)); const work = pending.get(frame.id); if (!work) return;
    pending.delete(frame.id); clearTimeout(work.timer); if (frame.error) work.reject(new Error('Native read failed')); else work.resolve(frame.result); });
  await new Promise<void>((resolve, reject) => { native!.once('open', resolve); native!.once('error', reject); });
  await rpc('initialize', { clientInfo: { name: 'opencraft_catalog_readonly_browser', version: '1.0.0' }, capabilities: { experimentalApi: true } });
  native.send(JSON.stringify({ method: 'initialized', params: {} }));
}
const rows = Array.from({ length: 222 }, (_, n) => ({ id: `t${n}`, name: `Conversation ${n}`, preview: '', cwd: '/synthetic',
  parentThreadId: null, forkedFromId: null, updatedAt: 1000 - n, createdAt: 1000 - n, turns: [], status: { type: 'idle' } }));
let release: (() => void) | undefined;
let hold = true, fail = false;
let pageCalls = 0;
const requests: { cursor: string | null; ms: number; rows: number }[] = [];
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error',
  resolve: { dedupe: ['react', 'react-dom'] }, cacheDir: 'node_modules/.vite-catalog-entry',
  optimizeDeps: { entries: ['tests/fixtures/catalog-entry-browser.tsx'] }, esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'catalog-entry-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => {
    if (req.url?.split('?')[0] === '/') { res.setHeader('content-type', 'text/html'); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/catalog-entry-browser.tsx"></script>'); return; }
    if (req.url?.split('?')[0] !== '/catalog-page' || req.method !== 'POST') return next();
    try {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 8192) throw Error('Too large'); }
      const { cursor, limit } = JSON.parse(body); assert.equal(limit, 50); assert.ok(cursor === null || typeof cursor === 'string');
      const start = performance.now(); pageCalls++;
      let page;
      if (replay) { const recorded = replay.get(cursor); assert.ok(recorded); await new Promise(resolve => setTimeout(resolve, recorded.ms)); page = recorded.page; }
      else if (nativeSocket) page = await rpc('thread/list', { cursor, limit, archived: false, sortDirection: 'desc', sortKey: 'updated_at' });
      else {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (cursor !== null && hold) await new Promise<void>(resolve => { release = resolve; });
        if (cursor !== null && fail) { res.statusCode = 403; res.end('{}'); return; }
        const offset = Number(cursor ?? 0); const data = rows.slice(offset, offset + 50);
        page = { data: offset === 0 ? [{ ...rows.at(-1)!, pinned: true }, ...data] : data,
          nextCursor: offset + 50 < rows.length ? String(offset + 50) : null };
      }
      requests.push({ cursor, ms: performance.now() - start, rows: page.data.length });
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(page));
    } catch { res.statusCode = 500; res.end('{}'); }
  }); } }],
});
let browser: any;
const evidence: any[] = [];
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
  const origin = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
  if (nativeSocket) {
    for (const [index, legacy] of [true, false, false, true, true, false, false, true, true, false].entries()) {
      if (pairedReplay && index % 2 === 0) {
        replay = new Map(); let cursor: string | null = null;
        do { const start = performance.now(); const page = await rpc('thread/list', { cursor, limit: 50, archived: false, sortDirection: 'desc', sortKey: 'updated_at' });
          replay.set(cursor, { page, ms: performance.now() - start }); cursor = page.nextCursor ?? null;
        } while (cursor !== null);
      }
      const before = requests.length; const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
      const errors: string[] = []; page.on('pageerror', (error: Error) => { errors.push(error.message); console.error(error.message); }); await page.addInitScript('window.__name=value=>value');
      await page.goto(`${origin}/?legacy=${legacy ? 1 : 0}`);
      await page.locator('.sidebar-activity-item').first().waitFor();
      const firstVisible = await page.evaluate(() => performance.now() - (window as any).catalogEntry.started);
      await page.waitForFunction(() => { const state = (window as any).catalogEntry?.snapshot(); return state && !state.fetching && state.status === 'success'; });
      const state = await page.evaluate(() => ({ observations: (window as any).catalogEntry.observations, count: (window as any).catalogEntry.cached().data.length }));
      assert.deepEqual(errors, []); evidence.push({ legacy, firstVisible, ...state, requests: requests.slice(before) });
      console.log(JSON.stringify({ legacy, firstVisible, count: state.count, complete: state.observations.at(-1).ms })); await page.close();
    }
  } else {
    for (const width of [390, 1100]) for (const theme of ['light', 'dark']) {
      hold = true; fail = false; release = undefined;
      const page = await browser.newPage({ viewport: { width, height: 850 }, hasTouch: width === 390 });
      const errors: string[] = []; page.on('pageerror', (error: Error) => { errors.push(error.message); console.error(error.message); }); await page.addInitScript('window.__name=value=>value');
      await page.goto(`${origin}/?theme=${theme}`); await page.locator('.sidebar-activity-item').first().waitFor();
      await page.waitForFunction(() => (window as any).catalogEntry?.snapshot().partial);
      assert.ok((await page.evaluate(() => (window as any).catalogEntry.cached()?.data.length)) > 0);
      assert.equal(await page.locator('.sidebar-tasks').getAttribute('aria-busy'), 'true');
      await page.getByText('Conversation 221', { exact: true }).waitFor();
      await page.locator('.sidebar-activity-item').first().click();
      assert.equal((await page.evaluate(() => (window as any).catalogEntry.actions)).length, 1);
      const before = await page.evaluate(() => (window as any).catalogEntry.snapshot());
      const pinnedTop = (await page.getByText('Conversation 221', { exact: true }).boundingBox())!.y;
      await page.screenshot({ path: `${output}/partial-${width}-${theme}.png` });
      hold = false; release?.();
      await page.waitForFunction(() => (window as any).catalogEntry.cached()?.data.length === 222);
      await page.waitForFunction(() => !(window as any).catalogEntry.snapshot().fetching);
      assert.ok(Math.abs((await page.getByText('Conversation 221', { exact: true }).boundingBox())!.y - pinnedTop) <= 1,
        'completing the directory must not move already visible pinned rows');
      assert.equal(await page.evaluate(() => {
        const rows = (window as any).catalogEntry.observations;
        const first = rows.findIndex((row: any) => row.rows > 0);
        return rows.slice(first).some((row: any) => row.rows === 0);
      }), false, 'first-page to complete handover never flashes an empty directory');
      await page.getByRole('searchbox', { name: 'Search conversations' }).fill('Conversation 199');
      await page.getByText('Conversation 199', { exact: true }).waitFor();
      await page.getByRole('searchbox', { name: 'Search conversations' }).fill('');
      // A failed refresh preserves the prior complete directory, never substitutes its first page.
      fail = true; await page.evaluate(() => { void (window as any).catalogEntry.refresh(); });
      await page.getByText("Couldn't load Fixture conversations", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => (window as any).catalogEntry.cached().data.length), 222);
      fail = false; await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await page.waitForFunction(() => (window as any).catalogEntry.snapshot().status === 'success' && !(window as any).catalogEntry.snapshot().fetching);
      await page.screenshot({ path: `${output}/complete-${width}-${theme}.png` });
      // Replacing a scope cannot reuse an old first-page placeholder.
      hold = true; release = undefined;
      await page.evaluate(() => (window as any).catalogEntry.replace());
      await page.waitForFunction(() => (window as any).catalogEntry.snapshot().partial);
      await page.evaluate(() => (window as any).catalogEntry.revoke());
      await page.waitForFunction(() => document.querySelectorAll('.sidebar-activity-item').length === 0);
      hold = false; release?.(); await page.waitForTimeout(250);
      assert.equal(await page.locator('.sidebar-activity-item').count(), 0);
      assert.deepEqual(errors, []); evidence.push({ width, theme, firstPage: before, pageCalls, errors }); await page.close();
    }
    // An early rename/archive/pin invalidates an in-flight cold read before a
    // complete cache exists. That invalidation must survive initial success.
    hold = true; fail = false; release = undefined;
    const mutationCalls = pageCalls;
    const mutationPage = await browser.newPage(); await mutationPage.addInitScript('window.__name=value=>value'); await mutationPage.goto(origin);
    await mutationPage.waitForFunction(() => (window as any).catalogEntry?.snapshot().partial);
    rows[0] = { ...rows[0]!, name: 'Conversation 0 renamed during initial load' };
    await mutationPage.evaluate(() => { for (let n = 0; n < 3; n++) void (window as any).catalogEntry.refresh(); });
    hold = false; release?.();
    await mutationPage.waitForFunction(() => (window as any).catalogEntry.cached()?.data.find((row: any) => row.id === 't0')?.name === 'Conversation 0 renamed during initial load', undefined, { timeout: 5000 });
    await mutationPage.getByText('Conversation 0 renamed during initial load', { exact: true }).waitFor();
    await mutationPage.waitForFunction(() => (window as any).catalogEntry.cached()?.data.length === 222);
    assert.ok(pageCalls - mutationCalls <= 10, 'notifications do not restart an unbounded directory crawl');
    await mutationPage.close(); rows[0] = { ...rows[0]!, name: 'Conversation 0' };
    // A lifecycle fact cancels an in-flight next page while committed rows stay visible.
    hold = true; fail = false; release = undefined;
    const eventPage = await browser.newPage(); await eventPage.addInitScript('window.__name=value=>value'); await eventPage.goto(origin);
    await eventPage.waitForFunction(() => (window as any).catalogEntry?.calls.length === 2);
    rows[0] = { ...rows[0]!, status: { type: 'active', activeFlags: [] } } as any;
    hold = false; release?.();
    await eventPage.evaluate(() => {
      (window as any).catalogFrameCounts = [];
      (window as any).sampleCatalogFrames = true;
      const sample = () => { (window as any).catalogFrameCounts.push(document.querySelectorAll('.sidebar-activity-item').length); if ((window as any).sampleCatalogFrames) requestAnimationFrame(sample); };
      sample(); (window as any).catalogEntry.notify();
    });
    await eventPage.waitForFunction(() => (window as any).catalogEntry.cached()?.data.length === 222 && !(window as any).catalogEntry.snapshot().fetching);
    assert.equal(await eventPage.evaluate(() => { (window as any).sampleCatalogFrames = false; return (window as any).catalogFrameCounts.some((count: number) => count === 0); }), false);
    assert.equal(await eventPage.evaluate(() => (window as any).catalogEntry.cached().data.find((row: any) => row.id === 't0').status.type), 'active');
    evidence.push({ scenario: 'notification-during-pagination', blankFrames: 0 });
    await eventPage.close(); rows[0] = { ...rows[0]!, status: { type: 'idle' } };
    // A later-page failure retains successful pages and exposes retry.
    hold = true; fail = false; release = undefined;
    const page = await browser.newPage(); await page.addInitScript('window.__name=value=>value'); await page.goto(origin);
    await page.waitForFunction(() => (window as any).catalogEntry?.snapshot().partial);
    hold = false; fail = true; release?.();
    await page.getByText("Couldn't load Fixture conversations", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => { const samples = (window as any).catalogEntry.observations; const first = samples.findIndex((sample: any) => sample.rows > 0); return samples.slice(first).some((sample: any) => sample.rows === 0); }), false);
    assert.ok(await page.locator('.sidebar-activity-item').count() > 0);
    assert.ok((await page.evaluate(() => (window as any).catalogEntry.cached()?.data.length)) > 0);
    fail = false; await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.waitForFunction(() => (window as any).catalogEntry.cached()?.data.length === 222);
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify({ mode: pairedReplay ? 'real-server-snapshot-timed-replay' : nativeSocket ? 'real-server-readonly' : 'synthetic-behavior', evidence }, null, 2));
  console.log(`Passed ${evidence.length} catalog entry scenarios`);
} finally { await browser?.close(); native?.close(); for (const work of pending.values()) clearTimeout(work.timer); await vite.close(); }
