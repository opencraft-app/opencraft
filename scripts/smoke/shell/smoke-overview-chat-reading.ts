import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';

const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? '.local/overview-reading');
await mkdir(output, { recursive: true });
const negative = process.argv.includes('--negative-control');
const originalRoot = process.env.OPENCRAFT_OVERVIEW_ORIGINAL_ROOT;
assert(!negative || originalRoot, 'negative control needs an explicit original source root');
const originals = new Map<string, string>();
if (negative) for (const file of ['apps/workbench-web/src/components/retained-view-preview.tsx', 'apps/workbench-web/src/styles/app.scss'])
  originals.set(resolve(file), await readFile(resolve(originalRoot!, file), 'utf8'));
const vite = await createServer({ configFile: 'apps/workbench-web/vite.config.ts', root: process.cwd(), logLevel: 'error',
  cacheDir: 'node_modules/.vite-overview-reading', server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'reading-fixture', enforce: 'pre', load: id => originals.get(id.split('?')[0]!), configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith('/?')) return next();
      res.setHeader('content-type', 'text/html');
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/overview-chat-reading.tsx"></script>');
    });
  } }] });
const receipt: unknown[] = [];
try {
  await vite.listen();
  for (const placement of (negative ? ['atomic'] : process.env.OPENCRAFT_OVERVIEW_WEBKIT ? ['atomic', 'popover', 'webkit'] : ['atomic', 'popover']) as Array<'atomic' | 'popover' | 'webkit'>) {
    const browser = await (placement === 'webkit' ? webkit : chromium).launch({ headless: true });
    try {
      for (const width of negative ? [390] : [390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: true });
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript('window.__name=value=>value');
        if (placement === 'popover') await page.addInitScript('delete Element.prototype.moveBefore');
        await page.goto(vite.resolvedUrls!.local[0]! + '?safe=34px', { waitUntil: 'commit' });
        await page.waitForFunction(() => !!(window as any).readingOverview?.destination);
        await page.getByRole('button', { name: 'Tabs', exact: true }).last().click();
        await page.getByRole('button', { name: 'Main chat', exact: true }).click();
        await page.waitForFunction(() => !(window as any).readingOverview.open);
        await page.locator('.opencraft-composer-editor').click();
        await page.keyboard.insertText('Preserve this draft');
        await page.waitForFunction(() => document.querySelector('.opencraft-composer-editor')?.textContent === 'Preserve this draft');
        const editor = await page.locator('.opencraft-composer-editor').elementHandle();
        const port = await page.locator('.thread-scroll').elementHandle();
        for (const historical of [false, true]) for (const reduced of [false, true]) {
          await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
          await page.locator('.thread-scroll').evaluate((node, historical) => { node.scrollTop = historical ? -220 : 0; node.dispatchEvent(new Event('scroll')); }, historical);
          // Sample real paint frames, not just final screenshots. Local coordinates
          // remove the intentional card transform, but keep transcript layout jumps.
          await page.evaluate(async () => {
            await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
            const w = window as any; w.readingFrames = []; w.readingCapture = true;
            const sample = () => {
              if (!w.readingCapture) return;
              const root = document.querySelector<HTMLElement>('[data-retained-view="primary-chat"]')!;
              const scroll = root.querySelector<HTMLElement>('.thread-scroll')!;
              const tail = [...scroll.querySelectorAll('p')].find(node => node.textContent === 'Paragraph 79: Read the original conversation.')!;
              const scale = Number(root.dataset.retainedPreviewScale ?? 1);
              w.readingFrames.push({ at: performance.now(), preview: root.dataset.retainedPreview === 'true',
                padding: getComputedStyle(root.querySelector('.thread-scroll-footer')!).paddingBottom,
                height: scroll.style.getPropertyValue('--thread-footer-height'), scroll: scroll.scrollTop,
                tail: (tail.getBoundingClientRect().bottom - root.getBoundingClientRect().top) / scale });
              requestAnimationFrame(sample);
            }; sample();
          });
          await page.locator('[data-testid="composer-panel-toggle"]').click();
          await page.getByRole('button', { name: 'Main chat', exact: true }).waitFor();
          await page.waitForFunction(() => (window as any).readingFrames.filter((frame: any) => frame.preview).length >= 4);
          // Keyboard activation and touch activation share the same transaction.
          const chat = page.getByRole('button', { name: 'Main chat', exact: true });
          if (width === 1280) { await chat.focus(); await page.keyboard.press('Enter'); } else await chat.tap();
          await page.waitForFunction(() => !(window as any).readingOverview.open);
          await page.evaluate(async () => { for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame); (window as any).readingCapture = false; });
          const frames = await page.evaluate(() => (window as any).readingFrames as Array<{ preview: boolean; padding: string; height: string; scroll: number; tail: number }>);
          const jumps = frames.filter(frame => frame.padding !== frames[0].padding || frame.height !== frames[0].height || Math.abs(frame.tail - frames[0].tail) > 1 || Math.abs(frame.scroll - frames[0].scroll) > 1);
          const label = `${placement}-${width}-${historical ? 'history' : 'latest'}-${reduced ? 'reduced' : 'motion'}`;
          await writeFile(output + '/' + label + '.json', JSON.stringify(frames, null, 2));
          await page.screenshot({ path: output + '/' + label + '.png' });
          assert(frames.some(frame => frame.preview), 'must actually borrow the reading view');
          if (negative) assert(jumps.length > 0, 'original must reproduce a reservation/text jump');
          else assert.equal(jumps.length, 0, label + ': transcript reservation and local reading position stay stable: ' + JSON.stringify(jumps.slice(0, 3)));
          assert.equal(await editor!.evaluate(node => node === document.querySelector('.opencraft-composer-editor')), true, 'same editor DOM');
          assert.equal(await port!.evaluate(node => node === document.querySelector('.thread-scroll')), true, 'same scroll owner DOM');
          assert.equal(await page.locator('.opencraft-composer-editor').innerText(), 'Preserve this draft');
          assert.deepEqual(errors, []);
          receipt.push({ label, frames: frames.length, jumps: jumps.length });
          console.log('PASS', label, 'jumps', jumps.length);
        }
        await page.close();
      }
    } finally { await browser.close(); }
  }
  await writeFile(output + '/receipt.json', JSON.stringify({ negative, cases: receipt }, null, 2));
} finally { await vite.close(); }
