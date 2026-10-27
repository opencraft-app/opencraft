import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { WebSocketServer } from 'ws';
import { DshAppServerAdapter } from '../../apps/local-agent-host/src/dsh-appserver-adapter';
import type { DshClient } from '../../apps/local-agent-host/src/dsh-client';

const output = process.env.OPENCRAFT_PERFORMANCE_OUTPUT;
assert.ok(output, 'Explicit performance output directory required');
const samples = Number(process.env.OPENCRAFT_PERFORMANCE_SAMPLES ?? 10);
assert.ok(Number.isSafeInteger(samples) && samples >= 10 && samples <= 100);
const profiles = [{ id: 'desktop', width: 1100, cpuRate: 1 }, { id: 'narrow', width: 390, cpuRate: 4 }];
const rows = Array.from({ length: 222 }, (_, n) => ({ id: `t${n}`, name: `Conversation ${n}`, preview: '', cwd: '/fixture', parentThreadId: null,
  forkedFromId: null, updatedAt: 1000 - n, createdAt: 1000 - n, turns: [], status: { type: 'idle' } }));
const events: any[] = [];
const push = (type: string, data: unknown) => events.push({ event: { seq: events.length, time: 1000, type, data } });
for (let turn = 0; turn < 12; turn++) {
  push('turn/start', { turn }); push('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: `Question ${turn}` }] });
  push('assistant/message', { turn, message: { content: [{ type: 'text', text: `Answer ${turn}\n` + 'Retained history content. '.repeat(40) }] } });
  push('turn/end', { turn, reason: { kind: 'completed' } });
}
let historyReads = 0;
const adapter = new DshAppServerAdapter({ call: async (method: string, payload: any) => {
  assert.equal(method, 'session.history'); historyReads++;
  const eligible = events.filter(row => payload.beforeSeq === undefined || row.event.seq < payload.beforeSeq);
  return { events: eligible.slice(-50), hasMore: eligible.length > 50 };
} } as unknown as DshClient);
(adapter as any).summaries.set('s', { sessionId: 's', running: false, blank: false, cwd: '/fixture', updatedAt: 1 });
adapter.setThreadEngine({ describe: async () => ({ historyHead: { nextSeq: events.length }, selection: { provider: 'fixture', model: 'fixture' },
  permissions: { approval: 'ask', sandbox: { mode: 'workspace-write', workspaceRoot: '/fixture' }, preset: 'custom' } }),
  resume: async () => { throw Error('Performance fixtures cannot activate execution'); }, create: async () => {}, fork: async () => {}, inject: async () => {}, release: async () => {} });
const requests: { cursor: string | null; rows: number }[] = [];
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', resolve: { dedupe: ['react', 'react-dom'] },
  cacheDir: 'node_modules/.vite-performance-gate', optimizeDeps: { entries: ['tests/fixtures/catalog-entry-browser.tsx', 'tests/fixtures/session-loading-browser.tsx'] },
  esbuild: { jsx: 'automatic' }, server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{ name: 'performance-workloads', configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const path = req.url?.split('?')[0];
      if (path === '/catalog' || path === '/session') {
        res.setHeader('content-type', 'text/html');
        res.end(`<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/${path === '/catalog' ? 'catalog-entry' : 'session-loading'}-browser.tsx"></script>`); return;
      }
      if (path !== '/catalog-page' || req.method !== 'POST') return next();
      try {
        let body = ''; for await (const chunk of req) { body += chunk; assert.ok(body.length <= 8192); }
        const { cursor, limit } = JSON.parse(body); assert.equal(limit, 50); assert.ok(cursor === null || typeof cursor === 'string');
        const offset = Number(cursor ?? 0); assert.ok([0, 50, 100, 150, 200].includes(offset));
        await new Promise(resolve => setTimeout(resolve, cursor === null ? 100 : 250));
        const data = rows.slice(offset, offset + 50);
        requests.push({ cursor, rows: data.length });
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data, nextCursor: offset + 50 < rows.length ? String(offset + 50) : null }));
      } catch { res.statusCode = 500; res.end('{}'); }
    });
  } }] });
const sockets = new WebSocketServer({ noServer: true });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const evidence: any[] = [];
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  vite.httpServer!.on('upgrade', (req, socket, head) => { if (req.url === '/benchmark-rpc') sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws, req)); });
  sockets.on('connection', ws => ws.on('message', async raw => {
    const request = JSON.parse(String(raw)); if (request.id === undefined) return;
    try {
      const result = request.method === 'initialize' ? { codexHome: '/fixture', platformFamily: 'unix', platformOs: 'linux', userAgent: 'performance-fixture', capabilities: { extensions: {
        'opencraft/resume-history': { version: 1, mode: 'paginated', initialTurnsPage: true, boundedRecovery: true },
      } } } : await adapter.dispatch(request.method, request.params);
      await new Promise(resolve => setTimeout(resolve, 40));
      if (ws.readyState === 1) ws.send(JSON.stringify({ id: request.id, result }));
    } catch { if (ws.readyState === 1) ws.send(JSON.stringify({ id: request.id, error: { code: -32601, message: 'Synthetic read unavailable' } })); }
  }));
  browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  const origin = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
  for (const profile of profiles) for (const kind of ['session', 'catalog']) {
    const measured: any[] = [], warm: any[] = [];
    for (let n = 0; n <= samples; n++) {
      const context = await browser.newContext({ viewport: { width: profile.width, height: 850 }, hasTouch: profile.width === 390 });
      const page = await context.newPage(); const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message)); await page.addInitScript('window.__name=value=>value');
      const cdp = await context.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuRate });
      const before = requests.length, readsBefore = historyReads;
      try {
        await page.goto(`${origin}/${kind}?thread=s${process.env.OPENCRAFT_PERFORMANCE_CATALOG_MODE === "legacy" ? "&legacy=1" : ""}`);
        if (kind === 'catalog') {
          await page.waitForFunction(() => (window as any).catalogEntry?.metrics.completePaintMs != null, undefined, { timeout: 20_000 });
          const value = await page.evaluate(() => { const w = (window as any).catalogEntry; return { ...w.metrics, count: w.cached()?.data.length,
            partialCached: w.observations.some((x: any) => x.rows > 0 && x.partial && x.cached), emptyHandover: w.observations.slice(w.observations.findIndex((x: any) => x.rows > 0)).some((x: any) => x.rows === 0) }; });
          assert.equal(value.count, 222); assert.equal(value.emptyHandover, false);
          if (process.env.OPENCRAFT_PERFORMANCE_CATALOG_MODE !== 'legacy') {
            assert.equal(value.partialCached, true, 'Successful pages are cached while the remaining directory loads');
          }
          assert.equal(requests.length - before, 5, 'complete directory must take exactly five pages');
          await page.getByRole('searchbox', { name: 'Search conversations' }).fill('Conversation 219');
          await page.getByText('Conversation 219', { exact: true }).waitFor();
          if (n) measured.push({ firstPaintMs: value.firstPaintMs, completePaintMs: value.completePaintMs });
        } else {
          await page.getByRole('button', { name: 'Open conversation', exact: true }).click();
          await page.waitForFunction(() => { const m = (window as any).loadingBenchmark?.metrics; return m?.paintedMs != null && m?.readyMs != null; }, undefined, { timeout: 20_000 });
          await page.getByText('Question 11', { exact: true }).waitFor();
          const value = await page.evaluate(() => ({ ...(window as any).loadingBenchmark.metrics }));
          assert.equal(value.frameCount, 10, "five latest turns retain their user and assistant frames"); assert.equal(historyReads - readsBefore, 1, 'cold history keeps its one native read');
          if (n) measured.push({ firstPaintMs: value.paintedMs, readyMs: value.readyMs });
          await page.getByRole('button', { name: 'Close conversation', exact: true }).click();
          const warmBefore = historyReads;
          await page.getByRole('button', { name: 'Open conversation', exact: true }).click();
          await page.waitForFunction(() => { const m = (window as any).loadingBenchmark?.metrics; return m?.paintedMs != null && m?.readyMs != null; }, undefined, { timeout: 20_000 });
          await page.getByText('Question 11', { exact: true }).waitFor();
          const cached = await page.evaluate(() => ({ ...(window as any).loadingBenchmark.metrics }));
          assert.equal(historyReads, warmBefore, 'unchanged warm history must not reread native history');
          if (n) warm.push({ firstPaintMs: cached.paintedMs, readyMs: cached.readyMs });
        }
        assert.deepEqual(errors, []);
        if (n === 1) await page.screenshot({ path: `${output}/${kind}-${profile.id}.png` });
      } catch (error) { await page.screenshot({ path: `${output}/failure-${kind}-${profile.id}.png` }).catch(() => {}); throw error; }
      finally { await context.close(); }
    }
    console.log(`Measured ${kind}-${profile.id}: ${measured.length} samples`);
    evidence.push({ id: `${kind}-${profile.id}`, width: profile.width, cpuRate: profile.cpuRate, samples: measured });
    if (kind === 'session') evidence.push({ id: `session-warm-${profile.id}`, width: profile.width, cpuRate: profile.cpuRate, samples: warm });
  }
} finally {
  await writeFile(`${output}/workbench.json`, JSON.stringify({ workloadVersion: 1, browser: browser?.version(), evidence }, null, 2));
  await browser?.close(); for (const socket of sockets.clients) socket.terminate(); await new Promise<void>(resolve => sockets.close(() => resolve())); await vite.close(); adapter.close();
}
