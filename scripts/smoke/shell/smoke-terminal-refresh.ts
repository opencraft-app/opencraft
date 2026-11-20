import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Full page reload with real Workbench runtime, panel service, RightPanel and
// TerminalPanel. The isolated synthetic process owner lives outside the page.
// No production credentials, shells or user terminals are accessed.
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? '/tmp/terminal-refresh';
await mkdir(output, { recursive: true });
const negative = process.env.OPENCRAFT_TERMINAL_REFRESH_NEGATIVE === '1';
const processes = new Map<string, any>();
let spawns = 0, kills = 0;
const requests: { method: string; params: any }[] = [];
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error',
  resolve: { dedupe: ['react', 'react-dom'] }, cacheDir: 'node_modules/.vite-terminal-refresh',
  esbuild: { jsx: 'automatic', target: 'esnext' }, server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'terminal-refresh-fixture', enforce: 'pre',
    transform(code, id) {
      if (negative && id.endsWith('/packages/workbench-runtime/src/appserver-runtime.ts')) {
        assert.ok(code.includes('terminalController.list(scope)'));
        return code.replace('terminalController.list(scope)', 'terminalController.list()');
      }
    }, configureServer(s) {
    s.middlewares.use(async (req, res, next) => {
      if (req.url?.split('?')[0] === '/') {
        res.setHeader('content-type', 'text/html');
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/terminal-refresh.tsx"></script>');
        return;
      }
      if (req.url !== '/terminal-refresh/rpc') return next();
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const { request, mode, draft } = JSON.parse(Buffer.concat(chunks).toString());
      const { method, params = {} } = request;
      requests.push({ method, params });
      let result: any = method.endsWith('/list') ? { data: [], nextCursor: null } : {};
      const notifications: any[] = [];
      let error: any;
      if (method === 'initialize') result = { userAgent: 'refresh-fixture', capabilities: { extensions:
        mode === 'legacy' ? { 'opencraft/terminal-restore': { version: 1 } } : { 'opencraft/terminal': { version: 1, available: true, recovery: true } } } };
      if (method === 'process/spawn') {
        spawns++;
        const process = { processHandle: params.processHandle, phase: 'running', exitCode: null,
          context: { resourceOwnerId: params.resourceOwnerId, threadId: params.threadId, projectId: params.projectId, cwd: params.cwd, shell: '/bin/bash' },
          output: [{ sequence: 1, stream: 'stdout', deltaBase64: Buffer.from('Original terminal before refresh\r\n$ ').toString('base64') }], nextSequence: 2, truncated: false };
        processes.set(params.processHandle, process);
        notifications.push({ method: 'process/outputDelta', params: { processHandle: params.processHandle, ...process.output[0] } });
      }
      if (method === 'process/list') {
        await new Promise(resolve => setTimeout(resolve, 100));
        result = { processes: [...processes.values()].filter(p => draft ? (!params.threadId || p.context.threadId === params.threadId) && (!params.projectId || p.context.projectId === params.projectId) : p.context.threadId === params.threadId && p.context.projectId === params.projectId) };
      }
      if (method === 'process/attach') {
        const process = processes.get(params.processHandle);
        if (!process || params.threadId !== process.context.threadId || params.projectId !== process.context.projectId) error = { code: -32602, message: 'Terminal scope missing' };
        else result = process;
      }
      if (method === 'process/kill') { kills++; processes.delete(params.processHandle); }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ response: error ? { error } : { result }, notifications }));
    });
  } }],
});
let browser;
const reports: unknown[] = [];
try {
  await server.listen(); browser = await chromium.launch({ headless: true });
  for (const mode of ['hands', 'legacy']) for (const touch of [true, false]) for (const draft of [false, true]) {
    processes.clear(); requests.length = 0; spawns = kills = 0;
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 844 }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage(); const errors: string[] = [];
    page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
    await page.addInitScript(({ touch }) => {
      (window as any).__name = (v: unknown) => v;
      document.addEventListener('DOMContentLoaded', () => document.documentElement.dataset.uiDensity = touch ? 'touch' : 'compact');
    }, { touch });
    await page.goto(server.resolvedUrls!.local[0] + '?mode=' + mode + (draft ? '&draft=1' : ''));
    await page.getByTestId('new-terminal').click();
    await page.locator('.xterm').waitFor().catch(async error => {
      console.error(JSON.stringify({ mode, touch, errors, state: await page.evaluate(() => (window as any).fixture.inspect()), body: await page.locator('body').innerText() }));
      await page.screenshot({ path: output + '/failure.png' }); throw error;
    });
    await page.waitForFunction(() => (window as any).fixture.inspect().output[0]?.length > 0);
    const before = await page.evaluate(() => (window as any).fixture.inspect());
    assert.equal(before.ids.length, 1);
    if (draft) await page.evaluate(() => history.replaceState(null, '', location.href + '&promoted=1'));
    await page.reload();
    await page.getByTestId('show-tools').click();
    await page.waitForFunction(() => (window as any).fixture.inspect().tabs.length === 1, undefined, { timeout: negative ? 3000 : 30000 }).catch(async error => {
      console.error(JSON.stringify({ afterReload: await page.evaluate(() => (window as any).fixture.inspect()), spawns, kills }));
      throw error;
    });
    await page.locator('.xterm').waitFor();
    await page.waitForFunction(() => (window as any).fixture.inspect().output[0]?.length > 0);
    const after = await page.evaluate(() => (window as any).fixture.inspect());
    assert.deepEqual(after.ids, before.ids); assert.deepEqual(after.tabs, before.tabs); assert.deepEqual(after.output, before.output);
    assert.equal(spawns, 1); assert.equal(kills, 0);
    assert.ok(requests.some(r => r.method === 'process/list' && r.params.threadId === 'refresh-thread' && r.params.projectId === 'refresh-project'));
    assert.ok(requests.some(r => r.method === 'process/attach' && r.params.threadId === (draft ? null : 'refresh-thread') && r.params.projectId === 'refresh-project'));
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${output}/${mode}-${touch}-${draft}.png` });
    reports.push({ mode, touch, draft, sameTerminal: true, outputPreserved: true, spawns, kills });
    await context.close();
  }
  await writeFile(`${output}/result.json`, JSON.stringify(reports, null, 2));
  console.log('PASS: full page reload restores the original terminal tab and output without respawn or kill (Hands/legacy, touch/pointer)');
} finally { await browser?.close(); await server.close(); }
