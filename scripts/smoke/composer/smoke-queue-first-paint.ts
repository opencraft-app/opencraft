import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createWorkbenchWebConfig } from '../../../apps/workbench-web/vite.config';

const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? '.local/queue-first-paint');
await mkdir(output, { recursive: true });
const negative = process.argv.includes('--negative-control');
const originalComposer = process.env.OPENCRAFT_QUEUE_ORIGINAL_COMPOSER;
if (negative && !originalComposer) throw new Error('Negative control requires OPENCRAFT_QUEUE_ORIGINAL_COMPOSER pointing to the original composer source.');
const config = createWorkbenchWebConfig({ command: 'serve', mode: 'development' });
const composer = resolve('packages/composer-editor/src/composer-editor.tsx');
let originalLoads = 0;
const vite = await createServer({ configFile: false, root: process.cwd(), cacheDir: '.local/queue-first-paint/vite-cache', logLevel: 'error',
  define: { 'process.env.NEXT_PUBLIC_REGION': '"cn"', 'process.env.NEXT_PUBLIC_PREVIEW_LOCALES': '""', 'import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN': '"false"', 'import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN': '"false"', 'import.meta.env.VITE_INCLUDE_HEADLESS_APPHOST': '"false"' },
  optimizeDeps: { ...config.optimizeDeps, include: [...config.optimizeDeps!.include!, '@opencraft/browser-core', '@opencraft/browser-core/presentation', '@opencraft/browser-core/metadata-sync'] },
  esbuild: { jsx: 'automatic' }, resolve: { dedupe: ['react', 'react-dom'] }, server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'queue-first-paint', enforce: 'pre', load(id) {
    if (negative && id.split('?')[0] === composer) { originalLoads++; return readFileSync(originalComposer!, 'utf8'); }
  }, configureServer(server) { server.middlewares.use((req, res, next) => {
    if (!req.url?.startsWith('/?')) return next();
    res.setHeader('content-type', 'text/html'); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/composer-attached-rail.tsx"></script>');
  }); } }] });
await vite.listen();
const browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--no-proxy-server'] });
const reports = [];
try {
  const combinations = negative ? [{ width: 390, mode: 'light', palette: 'neutral' }] : [390, 1280].flatMap(width => ['light', 'dark'].flatMap(mode => ['neutral', 'lavender'].map(palette => ({ width, mode, palette }))));
  for (const { width, mode, palette } of combinations) {
    console.log('case', width, mode, palette);
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width < 1000, isMobile: width < 1000 });
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    await page.addInitScript('window.__name = value => value;');
    let release!: () => void, blocked = 0;
    const controls = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/packages/composer-editor/src/queue-tray.tsx*', async route => { blocked++; await controls; await route.continue(); });
    try {
      await page.goto(vite.resolvedUrls!.local[0] + `?cold-queue&navigation&locale=zh-CN&mode=${mode}&palette=${palette}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
      const editor = page.locator('.opencraft-composer-editor'); await editor.waitFor(); await editor.fill('保留正在写的草稿');
      const originalEditor = await editor.elementHandle();
      await page.evaluate(() => (window as any).setRailState('queue'));
      const rows = page.locator('.opencraft-composer-queue-item'); await rows.first().waitFor();
      assert(blocked > 0, 'optional queue controls really remain unavailable');
      if (negative) {
        assert(originalLoads > 0); assert.equal((await rows.first().innerText()).trim(), '');
        assert((await rows.first().boundingBox())!.height > 0);
        await page.screenshot({ path: output + '/original-empty-rail.png' });
        reports.push({ originalEmptyRailReproduced: true }); continue;
      }
      const loading = page.locator('[data-queue-loading-preview="true"]');
      await loading.waitFor(); assert((await rows.first().innerText()).includes('检查文件变更，并保留现有操作'));
      assert.equal(await loading.locator('button').count(), 0, 'no imitation controls before their owner loads');
      assert.equal(await rows.first().getAttribute('aria-hidden'), null, 'message remains accessible');
      const frames = await page.evaluate(() => new Promise<{ count: number; empty: number; overflow: boolean }>(resolve => {
        let count = 0, empty = 0, overflow = false;
        const frame = () => { for (const row of document.querySelectorAll<HTMLElement>('.opencraft-composer-queue-item')) { if (!row.innerText.trim()) empty++; const r = row.getBoundingClientRect(); overflow ||= r.left < 0 || r.right > innerWidth + 1; } if (++count === 12) resolve({ count, empty, overflow }); else requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
      }));
      assert.equal(frames.empty, 0); assert.equal(frames.overflow, false);
      await page.evaluate(() => { (window as any).setRailCount(2); (window as any).setRailMessage('最新排队内容'); });
      await page.waitForFunction(() => document.querySelectorAll('.opencraft-composer-queue-item').length === 2);
      assert((await rows.allTextContents()).every(text => text.includes('最新排队内容')));
      await page.evaluate(() => { (window as any).setRailCount(1); (window as any).setRailAttachmentOnly(true); (window as any).setRailPausedReason('已保存在本地，恢复连接后自动发送'); });
      await page.waitForFunction(() => document.querySelector('.opencraft-composer-queue-item')?.textContent?.includes('现场截图.png'));
      assert((await loading.innerText()).includes('已保存在本地，恢复连接后自动发送'));
      await page.screenshot({ path: `${output}/${width}-${mode}-${palette}-cold.png` });
      await page.evaluate(() => (window as any).setRailState('none'));
      await page.waitForFunction(() => !document.querySelector('.opencraft-composer-queue-item'));
      assert.equal(await page.locator('.opencraft-composer-attached-rail').evaluate(node => node.getBoundingClientRect().height), 0);
      await page.evaluate(() => { (window as any).setRailAttachmentOnly(false); (window as any).setRailPausedReason(null); (window as any).setRailState('queue'); });
      await loading.waitFor(); assert((await rows.first().innerText()).includes('最新排队内容'));
      release();
      await rows.first().locator('.opencraft-composer-queue-item__preview-trigger').waitFor();
      await loading.waitFor({ state: 'hidden' });
      assert((await rows.first().innerText()).includes('最新排队内容'));
      assert(await editor.evaluate((node, original) => node === original, originalEditor));
      assert.equal(await editor.innerText(), '保留正在写的草稿');
      const steer = rows.first().locator('button.is-steer');
      if (width < 1000) await steer.tap(); else { await steer.focus(); await page.keyboard.press('Enter'); }
      assert.equal(await page.evaluate(() => (window as any).steerCount), 1);
      await page.screenshot({ path: `${output}/${width}-${mode}-${palette}-ready.png` });
      assert.deepEqual(errors, []);
      reports.push({ width, mode, palette, blocked, frames, immediateText: true, attachmentName: true, pausedReason: true, noEmptyRailAfterRemoval: true, currentDataAfterLoad: true, editorAndDraftPreserved: true, controlsWorkAfterLoad: true });
    } finally { release(); await context.close(); }
  }
  await writeFile(output + (negative ? '/negative.json' : '/receipt.json'), JSON.stringify({ negative, reports, boundary: 'Actual AppShell/OpenCraftComposer; synthetic queue custody; cold queue-controls network held until real content is asserted. No inference or production mutation.' }, null, 2));
  console.log(JSON.stringify({ success: true, negative, cases: reports.length }));
} finally { await browser.close(); await vite.close(); }
