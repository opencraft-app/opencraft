import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error',
  esbuild: { jsx: 'automatic' }, resolve: { dedupe: ['react', 'react-dom'] },
  server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'submit-chrome-fixture', configureServer(vite) {
    vite.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith('/?')) return next();
      res.setHeader('content-type', 'text/html');
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/touch-newera.tsx"></script>');
    });
  } }] });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  await server.listen();
  for (const mode of ['light', 'dark']) for (const accepted of [true, false]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 }, hasTouch: true });
    await page.addInitScript(() => { (window as any).__name = (value: unknown) => value; });
    await page.goto(`${server.resolvedUrls!.local[0]}?heldSubmit&mode=${mode}`);
    const editor = page.locator('.opencraft-composer-editor');
    await editor.waitFor();
    await page.evaluate(() => (window as any).setTouch(true));
    await editor.fill('是吗');
    // Safari does not necessarily focus a tapped send button. Reproduce that
    // focus boundary while the real Composer owns the held submit transaction.
    await editor.evaluate((element: HTMLElement) => element.blur());
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.opencraft-composer-stack')?.dataset.composerEditing === 'false');
    const shell = page.locator('.opencraft-composer-shell');
    const initial = await shell.evaluate(element => element.getBoundingClientRect().height);
    await page.evaluate(() => {
      (window as any).submitHeights = [];
      (window as any).sampleSubmit = true;
      const sample = () => {
        if (!(window as any).sampleSubmit) return;
        (window as any).submitHeights.push(document.querySelector('.opencraft-composer-shell')!.getBoundingClientRect().height);
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      document.querySelector<HTMLButtonElement>('.opencraft-composer-submit')!.click();
    });
    await page.waitForFunction(() => typeof (window as any).settleSubmit === 'function');
    await page.waitForTimeout(200);
    await page.evaluate(value => (window as any).settleSubmit(value), accepted);
    await page.waitForFunction(() => document.activeElement?.matches('.opencraft-composer-editor'));
    await page.waitForTimeout(100);
    const heights = await page.evaluate(() => { (window as any).sampleSubmit = false; return (window as any).submitHeights as number[]; });
    assert.ok(heights.length > 0 && heights.every(height => Math.abs(height - initial) < 1), JSON.stringify({ mode, accepted, initial, heights }));
    assert.equal((await editor.innerText()).trim(), accepted ? '' : '是吗');
    // An intentional blur after settlement can still return the empty editor to idle.
    if (accepted) {
      await editor.evaluate((element: HTMLElement) => element.blur());
      await page.waitForFunction(() => document.querySelector<HTMLElement>('.opencraft-composer-stack')?.dataset.composerEditing === 'false');
      assert.ok(await shell.evaluate(element => element.getBoundingClientRect().height) < initial);
    }
    console.log(JSON.stringify({ mode, accepted, frames: heights.length, height: initial }));
    await page.close();
  }
} finally { await browser.close(); await server.close(); }
