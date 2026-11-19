import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createWorkbenchWebServer } from '../../../scripts/serve-workbench-web.mjs';

// Real product bundle and static gateway; no real execution Host or account is attached.
const output = '.local/mobile-workspace-production';
const server = await createWorkbenchWebServer({ appServerTarget: null, loopbackOnly: true });
let browser;
try {
  await mkdir(output, { recursive: true });
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.id = 'production-phone'; frame.dataset.opencraftPreview = 'mobile'; frame.src = '/';
    Object.assign(frame.style, { position: 'fixed', zIndex: '99999', width: '390px', height: '844px', top: '30px', left: '30px' });
    document.body.append(frame);
  });
  const frame = page.frameLocator('#production-phone');
  await frame.locator('html[data-ui-density="touch"]').waitFor({ timeout: 120000 });
  await frame.locator('.app-shell-root').waitFor({ timeout: 120000 });
  assert.equal(await page.locator('html').getAttribute('data-ui-density'), 'compact');
  const entry = await page.locator('script[type="module"][src]').first().getAttribute('src');
  assert.equal(await frame.locator('script[type="module"][src]').first().getAttribute('src'), entry);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: output + '/same-application.png' });
  await writeFile(output + '/evidence.json', JSON.stringify({ entry, errors, checks: ['same production module', 'real bootstrap and Shell', 'independent touch presentation', 'no physical touch/Host/model validation'] }, null, 2));
  console.log('PASS same production application, frame-local touch presentation');
} finally {
  await browser?.close();
  await server.close();
}
