import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { RemoteBrowserService } from '../../../apps/headless-server/src/remote-browser-service.mjs';

const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? join(tmpdir(), 'side-chat-sync');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'side-chat-sync-server-'));
const metadata = new RemoteBrowserService({ root: directory, dataDirectory: directory, ownerConnector: null });
// Metadata synchronization must not start a media owner or depend on codecs.
metadata.start = async () => { throw Error('Media startup must not gate side-chat synchronization'); };
const failedCloseOwners = new Set<string>();
const writeMetadata = metadata.metadata.bind(metadata);
metadata.metadata = async (owner: string, input: any, ...rest: any[]) => {
  if (failedCloseOwners.has(owner) && input?.key === 'sideChats' && JSON.parse(input.value).some((r: any) => r.closed === true)) throw Error('fixture metadata commit rejected');
  return writeMetadata(owner, input, ...rest);
};
const children = new Map<string, any>(), calls: any[] = [];
const actor = (headers: any) => /(?:^|;\s*)fixtureActor=([^;]+)/.exec(headers.cookie ?? '')?.[1] ?? 'missing';
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error',
  optimizeDeps: { include: ['@opencraft/browser-core/metadata-limits', '@opencraft/browser-core/metadata-merge'] },
  resolve: { dedupe: ['react', 'react-dom'] }, cacheDir: 'node_modules/.vite-side-chat-sync',
  esbuild: { jsx: 'automatic', target: 'esnext' }, server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'side-chat-sync-fixture', configureServer(s) {
    s.httpServer!.on('upgrade', (request, socket, head) => {
      if (request.url?.split('?')[0] !== '/__opencraft_browser/stream') return;
      const ownerId = actor(request.headers);
      metadata.upgrade(request, socket, head, { ownerId, authorize() { assert.notEqual(ownerId, 'missing'); }, track() {} });
    });
    s.middlewares.use(async (request, response, next) => {
      if (request.url?.split('?')[0] === '/') {
        response.setHeader('content-type', 'text/html');
        response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/resource-refresh.tsx"></script>'); return;
      }
      if (request.url !== '/resource-refresh/rpc') return next();
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString()), owner = actor(request.headers); calls.push({ ...input, owner });
      let result: any = {};
      if (input.method === 'fork') {
        await new Promise(r => setTimeout(r, 300));
        assert.equal(input.options.ephemeral, false);
        result = { id: 'native-child-' + children.size, text: 'Original side answer retained across reload', owner }; children.set(result.id, result);
      }
      if (input.method === 'acquire') { await new Promise(r => setTimeout(r, 100)); result = children.get(input.id); if (!result || result.owner !== owner) { response.statusCode = 404; result = {}; } }
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
    });
  } }],
});
let browser;
const reports: any[] = [];
try {
  await server.listen(); browser = await chromium.launch({ headless: true });
  const origin = server.resolvedUrls!.local[0];
  for (const touch of [true, false]) {
    const owner = 'account-' + (touch ? 'touch' : 'pointer'), errors: string[] = [];
    async function device(touch: boolean, account = owner) {
      const context = await browser!.newContext({ viewport: { width: touch ? 390 : 1280, height: 844 }, hasTouch: touch, isMobile: touch });
      await context.addCookies([{ name: 'fixtureActor', value: account, url: origin }]);
      await context.addInitScript(({ touch }) => {
        (window as any).__name = (v: unknown) => v;
        Object.defineProperty(window, 'VideoDecoder', { value: undefined, configurable: true });
        document.addEventListener('DOMContentLoaded', () => document.documentElement.dataset.uiDensity = touch ? 'touch' : 'compact');
      }, { touch });
      const page = await context.newPage(); page.on('pageerror', error => { errors.push(error.message); console.error(error.stack); });
      page.on('console', message => { if(message.type() === 'error') console.error(message.text()); });
      await page.goto(origin + '?sync=1'); await page.getByTestId('new-sidechat').waitFor().catch(async error => { console.error(JSON.stringify({errors, body:await page.locator('body').innerText()})); await page.screenshot({path:join(output,'failure.png')}); throw error; });
      return { context, page };
    }
    const a = await device(touch), b = await device(!touch), other = await device(false, owner + '-other');
    try {
      await a.page.getByTestId('new-sidechat').click();
      await a.page.evaluate(() => (window as any).fixture.reconcileSideChats());
      assert.ok((await a.page.evaluate(() => (window as any).fixture.inspect())).tabs.length >= 1, 'pending creation must remain discoverable during reconciliation');
      await a.page.getByText('Original side answer retained across reload', { exact: true }).waitFor();
      await b.page.getByTestId('show-tools').click();
      await b.page.getByText('Original side answer retained across reload', { exact: true }).waitFor();
      const inspect = (page: typeof a.page) => page.evaluate(() => (window as any).fixture.inspect());
      const first = await inspect(a.page), second = await inspect(b.page);
      await b.page.evaluate(() => (window as any).fixture.detachSidechatPresentation());
      assert.deepEqual((await inspect(b.page)).sessions, first.sessions, 'presentation removal must not close the durable resource');
      assert.deepEqual((await inspect(b.page)).records, first.records);
      assert.deepEqual(second.sessions, first.sessions); assert.deepEqual(second.records, first.records);
      assert.equal(first.sessions.length, 1); assert.equal((await inspect(other.page)).sessions.length, 0);
      await b.page.screenshot({ path: `${output}/${touch ? 'pointer-receiver' : 'touch-receiver'}.png` });
      await b.page.reload(); await b.page.getByTestId('show-tools').click();
      await b.page.getByText('Original side answer retained across reload', { exact: true }).waitFor();
      assert.deepEqual((await inspect(b.page)).sessions, first.sessions);
      // A rejected close must restore the same live tab and expose its error.
      failedCloseOwners.add(owner);
      await b.page.evaluate(() => (window as any).fixture.closeAll());
      await b.page.getByRole('alert').filter({ hasText: 'Side chat close failed' }).waitFor();
      assert.deepEqual((await inspect(b.page)).sessions, first.sessions);
      assert.deepEqual((await inspect(b.page)).records, first.records);
      failedCloseOwners.delete(owner);
      await b.page.reload(); await b.page.getByTestId('show-tools').click();
      await b.page.getByText('Original side answer retained across reload', { exact: true }).waitFor();
      // Deliberately miss a push: a stale device must learn the close on reconnect.
      await a.context.setOffline(true); await a.page.evaluate(() => (window as any).fixture.disconnectMetadata());
      await b.page.evaluate(() => (window as any).fixture.closeAll());
      await b.page.waitForFunction(() => (window as any).fixture.inspect().records.length === 0);
      assert.equal((await inspect(a.page)).sessions.length, 1, 'offline reader still has its prior projection');
      await a.context.setOffline(false);
      await a.page.waitForFunction(() => (window as any).fixture.inspect().sessions.length === 0 && (window as any).fixture.inspect().tabs.length === 0);
      await a.page.reload(); await a.page.getByTestId('show-tools').click(); await a.page.waitForTimeout(300);
      assert.deepEqual((await inspect(a.page)).records, []);
      assert.equal(calls.filter(c => c.owner === owner && c.method === 'fork').length, 1);
      assert.equal(calls.filter(c => c.owner === owner && c.method === 'inject').length, 1);
      assert.equal(calls.filter(c => c.owner === owner && c.method === 'unsubscribe').length, 1);
      assert.equal(calls.filter(c => c.owner === owner && c.method === 'interrupt').length, 0);
      assert.deepEqual(errors, []);
      reports.push({ touchCreator: touch, originalId: first.sessions[0], references: first.records, twoIndependentStorageContexts: true, closedAfterReconnect: true, otherAccountIsolated: true, noReplacementFork: true, noMediaOwner: true });
      console.log('passed cross-device direction touchCreator=' + touch);
    } finally { await a.context.close(); await b.context.close(); await other.context.close(); }
  }
  await writeFile(join(output, 'report.json'), JSON.stringify(reports, null, 2));
} finally { await browser?.close(); await server.close(); await metadata.close(); await rm(directory, { recursive: true, force: true }); }
