import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from 'sass';
import { assertBrowserRuntimeDependencies } from './browser-smoke-preflight.mjs';

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
assertBrowserRuntimeDependencies(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ?? chromium.executablePath());
const css = compile('packages/design-system/src/desktop-view.web.scss').css;
const artifacts = await mkdtemp(join(tmpdir(), 'opencraft-visor-seam-'));
// Previous mask boundary, only for proving the regression and comparing the
// unchanged exterior. No reference-product installation is needed at runtime.
const baseline = `.ui-desktop-view__island::before{width:17px;mask-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 17 24'%3E%3Cpath d='M0 0H16L16.5 24C16.5 24 15.8019 12.2069 12.48 6.72C9.15808 1.23312 0 0 0 0Z'/%3E%3C/svg%3E")}
 .ui-desktop-view__island::after{width:17px;mask-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 17 25'%3E%3Cpath d='M16.5 0H0L0.5 25C0.5 25 0.698078 12.2069 4.02 6.72C7.34192 1.23312 16.5 0 16.5 0Z'/%3E%3C/svg%3E")}
 @container(width >= 48rem){.ui-desktop-view__island::before{width:16px;mask-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 24'%3E%3Cpath d='M0 0H16V24C16 24 15.8019 12.2069 12.48 6.72C9.15808 1.23312 0 0 0 0Z'/%3E%3C/svg%3E")}}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
const cases = [];
try {
  for (const width of [390, 1024]) for (const dpr of [1, 2, 3]) {
    const page = await browser.newPage({ viewport: { width, height: 180 }, deviceScaleFactor: dpr });
    await page.setContent(`<style>${css}</style><style>
      *{box-sizing:border-box}body{margin:0;background:white}
      .fixture{position:absolute;top:20px;left:74px;width:241px;height:66px}
      .ui-desktop-view *, .ui-desktop-view *::before,.ui-desktop-view *::after{animation:none!important;transition:none!important}
      </style><div class="ui-desktop-view" data-owned="true"><div class="fixture ui-desktop-view__island">
      <span class="ui-desktop-view__visor-background"><span></span></span></div></div>`);
    for (const gap of [0, .5]) {
    const fault = await page.addStyleTag({ content: `.ui-desktop-view__visor-background{clip-path:inset(0 ${gap}px 0 ${gap}px)}` });
    for (const fraction of [0, .25, .5, .75]) {
      const left = 74 + fraction;
      await page.locator('.fixture').evaluate((element, x) => { element.style.left = `${x}px`; }, left);
      const sample = async () => {
        const png = await page.screenshot();
        return page.evaluate(async ({ url, left, dpr }) => {
          const image = new Image(); image.src = url; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
          const pixels = [], exterior = [];
          for (let y = 24 * dpr; y < 40 * dpr; y++) {
            const rgb = context.getImageData(Math.ceil(left * dpr), y, 1, 1).data;
            pixels.push(rgb[1]);
            pixels.push(context.getImageData(Math.floor((left + 241) * dpr) - 1, y, 1, 1).data[1]);
            for (let x = Math.ceil((left - 17) * dpr); x < Math.floor(left * dpr); x++) exterior.push(context.getImageData(x, y, 1, 1).data[1]);
            for (let x = Math.ceil((left + 242) * dpr); x < Math.floor((left + 258) * dpr); x++) exterior.push(context.getImageData(x, y, 1, 1).data[1]);
          }
          return { pixels, exterior };
        }, { url: `data:image/png;base64,${png.toString('base64')}`, left, dpr });
      };
      const corrected = await sample();
      const old = await page.addStyleTag({ content: baseline });
      const previous = await sample(); await old.evaluate(element => element.remove());
      // Lighter-than-purple pixels mark background leaking through the join.
      assert.ok(corrected.pixels.every((green, index) => green <= previous.pixels[index] + 1), 'inside fill cannot worsen the join');
      assert.ok(corrected.exterior.every((green, index) => Math.abs(green - previous.exterior[index]) <= 1), 'outer curves must not move');
      cases.push({ width, dpr, fraction, simulatedInset: gap, previous: Math.max(...previous.pixels), corrected: Math.max(...corrected.pixels) });
      if (dpr === 3 && fraction === .5) await page.screenshot({ path: join(artifacts, `overlap-${width}-${gap}.png`) });
    }
    await fault.evaluate(element => element.remove());
    }
    await page.close();
  }
  console.log(JSON.stringify({ artifacts, cases, scope: 'Chromium rasterization; not iPhone Safari acceptance' }));
  assert.ok(cases.some(item => item.simulatedInset > 0 && item.corrected < item.previous - 10), 'overlap must tolerate independently clipped background edges');
} finally { await browser.close(); }
