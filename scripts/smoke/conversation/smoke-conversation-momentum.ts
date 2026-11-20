import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';

const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? '.local/conversation-momentum';
const baseline = process.env.OPENCRAFT_MOMENTUM_BASELINE === '1';
const engine = process.env.OPENCRAFT_MOMENTUM_ENGINE === 'webkit' ? webkit : chromium;
fs.mkdirSync(output, { recursive: true });
const files = ['packages/timeline-virtualizer/src/measurement.ts', 'packages/timeline-virtualizer/src/scroll-controller.ts',
  'packages/timeline-host-web/src/conversation-viewport-owner.ts', 'apps/workbench-web/src/components/conversation/virtualized-conversation-turns.tsx'];
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error',
  resolve: { dedupe: ['react', 'react-dom', 'react-intl'] },
  cacheDir: `node_modules/.vite-conversation-momentum-${baseline ? 'old' : 'new'}`,
  optimizeDeps: { entries: ['tests/fixtures/conversation-momentum.tsx'] },
  esbuild: { jsx: 'automatic' }, server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{
    name: 'momentum-regression', enforce: 'pre',
    load(id) {
      const rel = baseline && files.find(file => id.split('?')[0]!.endsWith('/' + file));
      if (rel) return execFileSync('git', ['show', `HEAD:${rel}`], { encoding: 'utf8' });
      return null;
    },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url?.split('?')[0] !== '/') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/conversation-momentum.tsx"></script>');
    }); },
  }] });
let browser;
const results = [];
try {
  await vite.listen(); browser = await engine.launch({ headless: true });
  for (const touch of [true, false]) {
    const context = await browser.newContext({ viewport: { width: touch ? 402 : 1100, height: 750 }, hasTouch: touch, isMobile: touch });
    await context.addInitScript(() => { (window as any).__name = (value: unknown) => value; });
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => { if (!error.message.includes('ResizeObserver loop')) errors.push(error.message); });
    await page.goto(vite.resolvedUrls!.local[0]! + '?natural&longHistory');
    await page.waitForFunction(() => (window as any).owner && document.querySelector('[data-probe="text-29"]'));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const evidence = await page.evaluate(async () => {
      const w = window as any, root = document.querySelector<HTMLElement>('.thread-scroll')!;
      const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      w.momentumDiagnostics = [];
      // Deterministic unreported physical motion: each position is written before
      // the scroll event and before the render-window/measurement commit. Browser
      // touch detection/density are real; this is not native iPhone inertia.
      const positions = [];
      for (let i = 0; i < 55; i++) {
        const expected = root.scrollTop - 90;
        root.scrollTop = expected;
        await frame(); await frame();
        positions.push({ expected, actual: root.scrollTop });
      }
      return { positions, diagnostics: w.momentumDiagnostics, scrollHeight: root.scrollHeight };
    });
    fs.writeFileSync(path.join(output, `${engine.name()}-${touch ? 'touch' : 'pointer'}-${baseline ? 'old' : 'fixed'}.json`), JSON.stringify(evidence, null, 2));
    const measurements = evidence.diagnostics.filter((e: any) => e.kind === 'turn-measurement' && e.fields.previousMeasured === null && Math.abs(e.fields.height - e.fields.layoutHeight) > 200);
    assert.ok(measurements.length >= 3, 'exercise several newly mounted, badly estimated rows');
    const writes = evidence.diagnostics.filter((e: any) => e.kind === 'scroll-write');
    assert.equal(writes.length, 0, 'upward hydration must not interrupt momentum with preservation or zero-delta writes');
    const maximumDrift = Math.max(...evidence.positions.map((p: any) => Math.abs(p.actual - p.expected)));
    assert.ok(maximumDrift <= 1, `unreported movement was rewritten by ${maximumDrift}px`);
    const anchorMotion = await page.evaluate(async () => {
      const w = window as any, root = document.querySelector<HTMLElement>('.thread-scroll')!;
      const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      w.owner.scrollController.scrollToDistanceFromBottomPx(2000, 'instant', 'user');
      for (let i = 0; i < 5; i++) await frame();
      // Real paragraphs inside the fixed-size fixture blocks exercise the DOM
      // text-anchor path without changing row height or installing a new owner.
      for (const block of root.querySelectorAll<HTMLElement>('[data-probe]')) {
        const paragraph = document.createElement('p'); paragraph.textContent = 'Reading anchor';
        paragraph.style.cssText = 'margin:0;line-height:22px'; block.prepend(paragraph);
      }
      const bounds = root.getBoundingClientRect();
      const paragraphs = [...root.querySelectorAll<HTMLElement>('[data-probe] > p')].filter(p => {
        const box = p.getBoundingClientRect(); return box.top >= bounds.top && box.bottom <= bounds.bottom;
      });
      if (!paragraphs.length) throw new Error('fixture has no visible reading paragraph');
      const paragraph = paragraphs[0]!;
      const index = Math.max(...paragraphs.map(p => Number(p.parentElement!.dataset.probe!.split('-')[1]))) + 1;
      if (index >= 29) throw new Error('fixture must resize a historical row below the reading viewport');
      w.owner.captureReadingAnchor(w.owner.measureMountedTurns());
      const before = paragraph.getBoundingClientRect().top;
      w.delayTurnMeasurements = true; w.commitMomentumChange(index, 720);
      for (let i = 0; i < 3; i++) await frame();
      if (!w.delayedMeasurement) throw new Error('fixture did not hold the row measurement');
      root.scrollTop -= 40; // native event has not reached JS when the held batch commits
      w.commitMomentumMeasurements();
      for (let i = 0; i < 4; i++) await frame();
      return { before, after: paragraph.getBoundingClientRect().top, userDelta: 40 };
    });
    assert.ok(Math.abs(anchorMotion.after - anchorMotion.before - anchorMotion.userDelta) <= 1,
      `text reflow correction rewound unreported motion: ${JSON.stringify(anchorMotion)}`);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, `${engine.name()}-${touch ? 'touch' : 'pointer'}.png`) });
    results.push({ touch, engine: engine.name(), hydratedRows: measurements.length, writes: writes.length, maximumDrift, anchorMotion, errors });
    await context.close();
  }
  fs.writeFileSync(path.join(output, `${engine.name()}-result.json`), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ baseline, results }));
} finally { await browser?.close(); await vite.close(); }
