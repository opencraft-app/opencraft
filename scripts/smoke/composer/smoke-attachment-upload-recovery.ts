import assert from 'node:assert/strict';
import {mkdtemp, mkdir, copyFile, rm, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createServer} from 'vite';
import {WebSocketServer} from 'ws';
import {AttachmentUploadStore} from '../../../apps/local-agent-host/src/attachments/attachment-upload-store';

// Actual Composer, browser resolver, Workbench runtime, WebSocket transport and
// Host upload store. Only initialize/control and the final file location are
// synthetic; no account, model, production Host or deployed application is used.
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? '.local/attachment-upload-smoke';
await mkdir(output, {recursive: true});
const engines = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
const playwright = engines.default ?? engines;
const vite = await createServer({configFile: false, root: process.cwd(), logLevel: 'error', esbuild: {jsx: 'automatic'},
  resolve: {dedupe: ['react', 'react-dom']}, server: {host: '127.0.0.1', port: 0}, plugins: [{name: 'upload-fixture', configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith('/?')) return next();
      res.setHeader('content-type', 'text/html');
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/attachment-upload-progress.tsx"></script>');
    });
  }}]});
const until = async (test: () => unknown | Promise<unknown>, label: string) => {
  const end = Date.now() + 20000;
  while (Date.now() < end) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Timed out: ' + label);
};
const evidence: unknown[] = [];
let browser: any;
try {
  await vite.listen();
  browser = await playwright.chromium.launch({headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox']});
  for (const touch of [false, true]) for (const mode of ['light', 'dark']) {
    const label = `${touch ? 'touch' : 'desktop'}-${mode}`;
    const root = await mkdtemp(join(tmpdir(), 'upload-browser-'));
    const refs = new Map<string, string>();
    let behavior: 'hold' | 'normal' | 'drop-final' | 'deny' = 'hold';
    let commits = 0, cancels = 0, removes = 0, connections = 0, dropped = false;
    const chunks: Array<{id: string; offset: number; retry: boolean}> = [];
    const held: Array<() => void> = [];
    const store = new AttachmentUploadStore(join(root, '.uploads'), async (request, path, hash) => {
      commits++; const target = join(root, request.clientAttachmentId); await copyFile(path, target); refs.set(request.clientAttachmentId, target);
      return {ref: {id: request.clientAttachmentId, name: request.name, mimeType: request.mimeType, size: request.size, sha256: hash,
        location: {kind: 'host-file', path: target}}};
    });
    const rpc = new WebSocketServer({host: '127.0.0.1', port: 0}); await once(rpc, 'listening');
    rpc.on('connection', socket => {
      connections++; socket.on('error', () => {});
      socket.on('message', async raw => {
        const request = JSON.parse(String(raw)); if (request.id === undefined) return;
        const reply = (result: unknown) => { if (socket.readyState === 1) socket.send(JSON.stringify({jsonrpc: '2.0', id: request.id, result})); };
        try {
          if (request.method === 'initialize') return reply({userAgent: 'fixture', codexHome: '/synthetic', platformFamily: 'unix', platformOs: 'linux', capabilities: {extensions: {
            'opencraft/attachment-staging': {version: 1, sources: ['client-bytes'], locations: ['host-file'], maxBytes: 1024 * 1024 * 1024, chunkBytes: 65536, uploadRetry: 'last-chunk-v1'},
          }}});
          if (request.method === 'attachment/uploadChunk') {
            if (behavior === 'deny') throw new Error('Synthetic upload refusal');
            chunks.push({id: request.params.uploadId, offset: request.params.offset, retry: request.params.retry === true});
            const result = await store.chunk(request.params);
            if (behavior === 'drop-final' && result.ref && !dropped) { dropped = true; behavior = 'normal'; socket.terminate(); return; }
            if (behavior === 'hold') { held.push(() => reply(result)); return; }
            return reply(result);
          }
          if (request.method === 'attachment/uploadCancel') { cancels++; return reply(await store.cancel(request.params.uploadId)); }
          if (request.method === 'attachment/remove') {
            const path = refs.get(request.params.id); if (path) { await rm(path, {force: true}); refs.delete(request.params.id); removes++; }
            return reply({removed: !!path});
          }
          return reply({data: [], nextCursor: null});
        } catch (error) { if (socket.readyState === 1) socket.send(JSON.stringify({jsonrpc: '2.0', id: request.id, error: {code: -32602, message: String((error as Error).message)}})); }
      });
    });
    const address = rpc.address() as {port: number};
    const context = await browser.newContext({viewport: {width: touch ? 390 : 1280, height: 844}, hasTouch: touch, isMobile: touch});
    const page = await context.newPage(); const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await context.addInitScript(() => { (window as any).__name = (value: unknown) => value; });
    const row = (name: string) => page.locator('.opencraft-composer-attachment').filter({has: page.locator('strong', {hasText: name})});
    const snapshot = () => page.evaluate(() => (window as any).uploadFixture.controller.getSnapshot());
    const addFile = async (name: string) => {
      const choosing = page.waitForEvent('filechooser');
      await press(page.getByRole('button', {name: 'Attach files', exact: true}));
      const chooser = await choosing;
      await chooser.setFiles({name, mimeType: 'text/plain', buffer: Buffer.alloc(131072, 65)});
    };
    const press = async (button: any) => touch ? button.tap() : button.click();
    try {
      await page.goto(vite.resolvedUrls!.local[0] + `?mode=${mode}&rpc=${encodeURIComponent(`ws://127.0.0.1:${address.port}`)}`);
      await page.waitForFunction(() => !!(window as any).uploadFixture);
      await page.evaluate(() => (window as any).uploadFixture.ready);
      let editor = page.locator('.ProseMirror').first(); await editor.fill('keep this draft'); await editor.press('End');
      await addFile('notes.txt'); await until(() => held.length === 1, 'first chunk held');
      await until(async () => await row('notes.txt').getByRole('progressbar').getAttribute('aria-valuenow') === '50', 'sent fraction visible');
      const before = await row('notes.txt').boundingBox();
      assert((await row('notes.txt').innerText()).includes('50%'));
      assert.equal((await snapshot()).draft.attachments[0].lifecycle, 'uploading');
      const removeTarget = page.getByRole('button', {name: 'Remove notes.txt', exact: true});
      const initialTarget = await removeTarget.boundingBox();
      assert(initialTarget!.width >= (touch ? 44 : 22) && initialTarget!.height >= (touch ? 44 : 22), 'shared input density sets a reachable cancel target');
      await page.setViewportSize({width: touch ? 1280 : 390, height: 844});
      const resizedTarget = await removeTarget.boundingBox();
      assert.equal(resizedTarget!.width, initialTarget!.width, 'container size does not change input density');
      assert.equal((await snapshot()).draft.attachments[0].lifecycle, 'uploading');
      await page.setViewportSize({width: touch ? 390 : 1280, height: 844});
      await page.screenshot({path: `${output}/${label}-half.png`});
      held.shift()!(); await until(() => held.length === 1, 'final receipt held');
      await until(async () => (await row('notes.txt').innerText()).includes('Processing'), 'sent is not confirmed');
      assert.equal((await snapshot()).draft.attachments[0].lifecycle, 'uploading');
      assert.equal(await row('notes.txt').getByRole('progressbar').getAttribute('aria-valuenow'), '100');
      assert.equal(await page.locator('.opencraft-composer-submit').isDisabled(), true, 'sent bytes cannot enable submission without a committed ref');
      const sent = await row('notes.txt').boundingBox(); assert.equal(before!.height, sent!.height, 'metadata keeps one stable row');
      assert.equal(await page.evaluate(() => {const editor = document.querySelector('.ProseMirror'); return editor === document.activeElement || !!editor?.contains(document.activeElement);}), true, 'progress keeps input focus');
      await page.evaluate(() => (window as any).uploadFixture.setMounted(false)); await page.locator('.ProseMirror').waitFor({state: 'detached'});
      await page.evaluate(() => (window as any).uploadFixture.setMounted(true)); await row('notes.txt').waitFor();
      assert((await row('notes.txt').innerText()).includes('Processing')); assert.equal(await page.locator('.ProseMirror').first().innerText(), 'keep this draft');
      behavior = 'normal'; held.shift()!();
      await until(async () => await row('notes.txt').getAttribute('data-state') === 'ready', 'confirmed ready');
      assert.equal(await row('notes.txt').getByRole('progressbar').count(), 0); assert.equal(commits, 1);
      assert.equal(await page.locator('.opencraft-composer-submit').isEnabled(), true);
      await press(page.locator('.opencraft-composer-submit'));
      assert.equal(await page.evaluate(() => (window as any).uploadFixture.getSubmissionCount()), 1);
      assert.equal(await page.locator('.ProseMirror').first().innerText(), 'keep this draft', 'refused synthetic submission preserves the draft');
      assert.equal((await readFile([...refs.values()][0]!)).length, 131072);
      await press(page.getByRole('button', {name: 'Remove notes.txt', exact: true})); await until(() => removes === 1, 'normal ref cleanup');
      behavior = 'drop-final'; dropped = false; await addFile('retry.txt');
      await until(async () => await row('retry.txt').getAttribute('data-state') === 'ready', 'lost final ack recovers');
      assert.equal(commits, 2, 'lost final ACK commits exactly once'); assert(chunks.some(chunk => chunk.retry)); assert(connections >= 2);
      behavior = 'deny'; await addFile('failure.txt');
      await until(async () => await row('failure.txt').getAttribute('data-state') === 'failed', 'failure stays visible');
      await page.screenshot({path: `${output}/${label}-failed.png`});
      behavior = 'normal'; await press(page.getByRole('button', {name: 'Retry failure.txt', exact: true}));
      await until(async () => await row('failure.txt').getAttribute('data-state') === 'ready', 'explicit retry uses retained File'); assert.equal(commits, 3);
      behavior = 'hold'; await addFile('cancel.txt'); await until(() => held.length === 1, 'cancellable partial');
      await press(page.getByRole('button', {name: 'Remove cancel.txt', exact: true}));
      behavior = 'normal'; held.shift()!(); await until(() => cancels >= 1, 'cancel retires spool after admitted chunk settles');
      assert.equal(await row('cancel.txt').count(), 0); assert.equal(commits, 3);
      // A removed Draft can race a final committed acknowledgement. The proved
      // orphan ref must be retired without touching a different Host generation.
      behavior = 'hold'; await addFile('late-final.txt'); await until(() => held.length === 1, 'late first chunk');
      held.shift()!(); await until(() => held.length === 1, 'late final receipt');
      const cleanupBefore = removes;
      await press(page.getByRole('button', {name: 'Remove late-final.txt', exact: true}));
      behavior = 'normal'; held.shift()!(); await until(() => removes === cleanupBefore + 1, 'orphan final ref released');
      assert.equal(await row('late-final.txt').count(), 0); assert.equal(commits, 4);
      assert.equal(await page.locator('.ProseMirror').first().innerText(), 'keep this draft');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({path: `${output}/${label}-ready.png`});
      assert.deepEqual(errors, []);
      evidence.push({label, commits, cancels, removes, connections, exactRetries: chunks.filter(chunk => chunk.retry).length,
        input: touch ? 'isMobile+hasTouch and tap' : 'mouse/keyboard', actualOwners: 'Composer/browser resolver/Workbench runtime/WebSocket/Host upload store', errors});
    } catch (error) { await page.screenshot({path: `${output}/${label}-error.png`}).catch(() => {}); throw error; }
    finally {
      for (const release of held.splice(0)) release();
      await page.evaluate(() => (window as any).uploadFixture?.runtime.dispose()).catch(() => {});
      await context.close(); for (const socket of rpc.clients) socket.terminate(); await new Promise<void>(resolve => rpc.close(() => resolve()));
      await store.close(); await rm(root, {recursive: true, force: true});
    }
  }
  await writeFile(`${output}/report.json`, JSON.stringify(evidence, null, 2) + '\n'); console.log(JSON.stringify(evidence, null, 2));
} finally { await browser?.close(); await vite.close(); }
