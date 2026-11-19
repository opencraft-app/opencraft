import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { createWorkbenchWebConfig } from '../../../apps/workbench-web/vite.config';
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? '.local/root-lazy-presentation-smoke';
await mkdir(output, { recursive: true });
const hosts = JSON.stringify([{ hostId: 'opencraft-server', label: 'Recovery fixture', kind: 'local', url: '/appserver' }]);
const common = createWorkbenchWebConfig({ mode: 'development', command: 'serve' }, { hyperNode: false, builtinAgents: false });
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', cacheDir: 'node_modules/.vite-root-lazy-presentation',
  optimizeDeps: { ...common.optimizeDeps, include: [...common.optimizeDeps?.include ?? [],
    '@opencraft/browser-core/presentation', '@opencraft/browser-core/metadata-sync', '@opencraft/browser-core/metadata-merge'] },
  define: { 'process.env.NEXT_PUBLIC_REGION': '"cn"', 'process.env.NEXT_PUBLIC_PREVIEW_LOCALES': '""',
    'import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN': '"false"', 'import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN': '"false"',
    'import.meta.env.VITE_INCLUDE_HEADLESS_APPHOST': '"true"', 'import.meta.env.VITE_APPSERVER_HOSTS_JSON': JSON.stringify(hosts),
  }, esbuild: { jsx: 'automatic' }, resolve: { dedupe: ['react', 'react-dom'] }, server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'auth-expiry-workbench', configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url?.split('?')[0] === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/auth-expiry-workbench.tsx"></script></body></html>'); }
    else next();
  }); } }],
});
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
  const rows: unknown[] = [];
  for (const width of [390, 1280]) for (const presentation of ['sheet', 'history', 'gate']) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width === 390, isMobile: width === 390 });
    let authenticated = true, allocations = 0;
    const wires = new Set<any>();
    await context.route('**/__opencraft*/**', async (route: any) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/__opencraft_access/admission') await route.fulfill({ status: authenticated ? 204 : 401, body: authenticated ? '' : '{"error":"authentication_required"}', contentType: 'application/json' });
      else await route.fulfill({ status: 404, body: '{}' });
    });
    await context.routeWebSocket('**/apphost?*', (wire: any) => {
      allocations++; wires.add(wire);
      wire.onMessage((raw: string) => {
        const frame = JSON.parse(raw);
        if (frame.type === 'hello') wire.send(JSON.stringify({ type: 'ready', protocolVersion: 2, services: ['appserver'], capabilities: { connectionProbe: true } }));
        else if (frame.requestId) {
          wire.send(JSON.stringify({ type: 'response', requestId: frame.requestId, ok: true, result: frame.type === 'host/connect' ? { hostId: frame.hostId, generation: 1 } : null }));
          if (frame.type !== 'host/send') return;
          const request = JSON.parse(frame.frame); if (request.id === undefined) return;
          const result = request.method === 'initialize' ? { codexHome: '/synthetic', platformFamily: 'unix', platformOs: 'linux', userAgent: 'auth-smoke' }
            : request.method.endsWith('/list') ? { data: [], nextCursor: null } : undefined;
          const reply = result === undefined ? { id: request.id, error: { code: -32601, message: 'Unsupported synthetic engine method' } } : { id: request.id, result };
          wire.send(JSON.stringify({ type: 'host/frame', hostId: frame.hostId, generation: frame.generation, frame: JSON.stringify(reply) }));
        }
      });
    });
    let requests = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await context.route('**/apps/workbench-web/src/components/agent-management.tsx*', async route => {
      requests++;
      await held;
      await route.continue();
    });
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript('window.__name=value=>value');
    try {
      await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/`, { timeout: 90_000 });
      await page.waitForFunction(() => (window as any).authRecovery?.snapshot().phase === 'ready', undefined, { timeout: 60_000 });
      const editor = page.locator('[contenteditable="true"]').first();
      await editor.fill('Retained root lazy-loading draft');
      await editor.evaluate(node => { (window as any).retainedLazyEditor = node; });
      assert.equal(requests, 0, 'empty initial application does not eagerly load onboarding renderer');
      await page.evaluate(presentation => window.dispatchEvent(new CustomEvent('opencraft:replay-agent-onboarding', {
        detail: presentation === 'history' ? { intent: 'history' } : { presentation },
      })), presentation);
      const pending = page.getByRole('dialog', { name: 'Loading…', exact: true });
      await pending.waitFor();
      assert.equal(requests, 1, 'real App lazy boundary requested the held renderer');
      assert.equal(await pending.getAttribute('aria-modal'), String(presentation === 'gate'));
      if (presentation !== 'gate') {
        await pending.getByRole('button', { name: 'Cancel', exact: true }).click();
        assert.equal(await pending.count(), 0, 'cancel works while module request is unresolved');
      } else {
        assert.equal(await pending.getByRole('button', { name: 'Cancel', exact: true }).count(), 0, 'required gate has no cancel escape');
        // Close through the actual root's explicit sheet presentation, not a test-only state setter.
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('opencraft:replay-agent-onboarding', { detail: { presentation: 'sheet' } })));
        await pending.getByRole('button', { name: 'Cancel', exact: true }).click();
      }
      const arrived = page.waitForResponse(response => response.url().includes('/components/agent-management.tsx'));
      release(); await arrived;
      // Await the actual module evaluation, including its transitive imports,
      // not merely the HTTP response. Canceled React state must stay retired.
      await page.evaluate("import('/apps/workbench-web/src/components/agent-management.tsx').then(() => true)");
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.getByRole('dialog').count(), 0, 'late module completion cannot resurrect canceled onboarding');
      assert.equal(await editor.evaluate(node => node === (window as any).retainedLazyEditor), true, 'actual root retains the editor DOM');
      assert.equal(await editor.innerText(), 'Retained root lazy-loading draft');
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `${output}/${width}-${presentation}.png` });
      rows.push({ width, presentation, rendererRequests: requests, canceledBeforeLoad: true, editorRetained: true, pageErrors: errors });
    } catch (error) {
      console.error('root lazy boundary failure', {width, presentation, requests, errors}, await page.locator('body').innerText());
      await page.screenshot({path:`${output}/failure-${width}-${presentation}.png`});
      throw error;
    } finally { release(); await context.close(); }
  }
  await writeFile(`${output}/results.json`, JSON.stringify({scope:'Actual WorkbenchRoot/App with synthetic AppHost protocol only; real dynamic module request held. No native/model execution.',rows}, null, 2));
  console.log('PASS actual root lazy onboarding cancellation', JSON.stringify(rows));
} finally { await browser?.close(); await vite.close(); }
