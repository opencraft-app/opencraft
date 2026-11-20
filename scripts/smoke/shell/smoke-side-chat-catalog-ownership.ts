import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? '/tmp/side-chat-catalog-ownership';
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error',
  optimizeDeps: { include: ['@opencraft/browser-core/metadata-limits', '@opencraft/browser-core/metadata-merge'] },
  resolve: { dedupe: ['react', 'react-dom'] }, cacheDir: process.env.OPENCRAFT_SMOKE_VITE_CACHE ?? 'node_modules/.vite-side-chat-catalog',
  esbuild: { jsx: 'automatic', target: 'esnext' }, server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'side-chat-catalog-fixture', configureServer(s) {
    s.middlewares.use((req, res, next) => {
      if (req.url?.split('?')[0] !== '/') return next();
      res.setHeader('content-type', 'text/html');
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/side-chat-catalog.tsx"></script>');
    });
  } }],
});
const reports: unknown[] = [];
let browser;
try {
  await server.listen(); browser = await chromium.launch({ headless: true });
  for (const touch of [false, true]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 844 }, hasTouch: touch, isMobile: touch });
    try {
      const page = await context.newPage(), errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(({ touch }) => {
        document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.uiDensity = touch ? 'touch' : 'compact'; });
      }, { touch });
      await page.goto(server.resolvedUrls!.local[0]);
      const main = page.getByRole('button', { name: /Main conversation/ });
      const branch = page.getByRole('button', { name: /Ordinary fork/ });
      const assertOrdinary = async () => {
        await main.waitFor(); await branch.waitFor();
        await page.getByRole('button', { name: /Other Host conversation/ }).waitFor();
        assert.equal(await page.getByText('Saved owned conversation', { exact: true }).count(), 0);
        assert.equal(await page.getByText('New owned conversation', { exact: true }).count(), 0);
      };
      await assertOrdinary();
      await page.evaluate(() => (window as any).catalogProbe.begin());
      await page.waitForFunction(() => (window as any).catalogProbe.inspect().pendingBoundary);
      await assertOrdinary();
      assert.equal(await page.evaluate(() => (window as any).catalogProbe.inspect().newOwnership), 'side-chat');
      await page.evaluate(() => (window as any).catalogProbe.finish());
      await (touch ? branch.tap() : branch.click());
      await assertOrdinary();
      await page.evaluate(() => (window as any).catalogProbe.close('new'));
      const before = await page.evaluate(() => (window as any).catalogProbe.inspect());
      await page.reload(); await assertOrdinary();
      const after = await page.evaluate(() => (window as any).catalogProbe.inspect());
      assert.deepEqual(after.calls, before.calls, 'Reload classification cannot connect, fork, resume or interrupt an engine');
      assert.equal(after.rawCount, 5, 'Raw resource catalog remains intact');
      assert.equal(after.newOwnership, 'side-chat', 'Closed ownership survives reload');
      assert.deepEqual(errors, []);
      const mode = touch ? 'touch' : 'pointer';
      await page.screenshot({ path: join(output, mode + '.png') });
      reports.push({ mode, calls: after.calls, rawCount: after.rawCount, newOwnership: after.newOwnership });
    } finally { await context.close(); }
  }
  await writeFile(join(output, 'report.json'), JSON.stringify({ reports, evidence: 'Actual Sidebar and shared App catalog hook; synthetic native Host, no real cross-engine execution' }, null, 2));
  console.log(JSON.stringify({ output, reports }));
} finally { await browser?.close(); await server.close(); }
