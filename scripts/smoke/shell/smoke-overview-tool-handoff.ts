import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium, type Page } from 'playwright';

const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? '.local/overview-tool-handoff');
await mkdir(output, { recursive: true });
const fixture = resolve('tests/fixtures/overview-tool-handoff.tsx');
const vite = await createServer({ configFile: 'apps/workbench-web/vite.config.ts', root: process.cwd(), logLevel: 'error',
  resolve: { dedupe: ['react', 'react-dom', 'react-intl'] }, esbuild: { jsx: 'automatic' },
  cacheDir: resolve(output, 'vite-cache'),
  optimizeDeps: { entries: [fixture], include: ['react', 'react/jsx-runtime', 'react-dom/client', 'react-intl', '@xterm/xterm', '@shikijs/langs/typescript'] },
  server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{
    name: 'tool-handoff-read-only-probes', enforce: 'pre',
    resolveId(id, importer) {
      if (id.endsWith('/appserver-runtime-context') && importer?.includes('/panels/')) return '\0tool-handoff-runtime';
    },
    load(id) {
      if (id === '\0tool-handoff-runtime') return `export * from '/tests/fixtures/workspace-media-runtime.ts';
        export function useThreadCatalog(){return {threads:[{id:'parent',title:'Parent conversation'}]}}`;
    },
    transform(code, id) {
      if (!id.endsWith('/overview-scene-motion.ts')) return;
      // Observe the actual owner, synchronously on both sides of its commit.
      // Never replace geometry, playback, readiness, or feature behavior.
      const enter = 'if (!entering && !returning && prepared && cardness <= handback && finishScene) {';
      const leave = 'else clean();\n        });';
      const play = 'const playback = animate(progress, entering ? 1 : 0,';
      assert(code.includes(enter) && code.includes(leave) && code.includes(play), 'real scene instrumentation anchors changed');
      return code.replace(enter, enter + '\n(window as any).toolHandoffProbe?.("before", {key, scene, cardness, raster});')
        .replace(leave, leave + '\n(window as any).toolHandoffProbe?.("after", {key, scene, cardness, raster});')
        .replace(play, '(window as any).toolPlaybackProbe?.({key, entering, raster, prepared, scene});\n      ' + play);
    },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url === '/') {
        res.setHeader('content-type', 'text/html');
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/overview-tool-handoff.tsx"></script>');
      } else if (req.url === '/fixture/handoff.txt') {
        res.setHeader('content-type', 'text/plain'); res.end('Original file resource\nKeep this file viewer and its selection.\n'.repeat(30));
      } else next();
    }); },
  }] });
const targets = [
  { kind: 'terminal', selector: '[data-tool-terminal]', origin: 'resource' },
  { kind: 'resource', selector: '[data-tool-file]', origin: 'sidechat' },
  { kind: 'sidechat', selector: '.side-chat-panel', origin: 'terminal' },
  { kind: 'browser', selector: '[data-tool-browser]', origin: 'resource' },
] as const;
const frames = (page: Page, count: number) => page.evaluate(count => new Promise<void>(resolve => {
  let i = 0; const tick = () => ++i < count ? requestAnimationFrame(tick) : resolve(); requestAnimationFrame(tick);
}), count);
async function openOverview(page: Page) {
  // Retained controls can be CSS-visible while parked outside the current scene.
  // Use the reachable real action with trusted touch input, as the shared smoke does.
  const control = await page.waitForFunction(() => {
    for (const button of document.querySelectorAll<HTMLElement>('button[data-testid="composer-panel-toggle"], button.panel-mobile-dock__tabs')) {
      const r = button.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (r.width && r.height && x > 0 && y > 0 && x < innerWidth && y < innerHeight && button.contains(document.elementFromPoint(x, y))) return button;
    }
    return null;
  });
  const button = control.asElement();
  assert(button, 'current scene exposes a reachable overview action');
  // Let Playwright wait for the same reachable control to stop moving before
  // trusted touch contact. Warm-up dock allocation must not make setup miss it.
  await button.tap();
  await page.waitForFunction(() => (window as any).overview.open && !document.querySelector('[data-overview-flight]'));
}
const results: any[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const placement of ['atomic', 'popover'] as const) for (const target of targets) for (const source of (target.kind === 'browser' ? ['primary', 'other-tool', 'wide', 'preparing-resize'] : ['primary', 'other-tool', 'wide']).filter(source => !process.env.OPENCRAFT_TOOL_SOURCE || source === process.env.OPENCRAFT_TOOL_SOURCE)) {
    const label = `${placement}-${source}-to-${target.kind}${source === 'other-tool' ? '-resize' : ''}`;
    if (process.env.OPENCRAFT_TOOL_CASE && !label.includes(process.env.OPENCRAFT_TOOL_CASE)) continue;
    await rm(resolve(output, label + '-failed.png'), { force: true });
    const faults: string[] = [], errors: string[] = [];
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'no-preference' });
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message));
    let capture: any;
    console.log('START', label);
    try {
      await page.addInitScript('window.__name=value=>value');
      if (placement === 'popover') await page.addInitScript('delete Element.prototype.moveBefore');
      await page.goto(vite.resolvedUrls!.local[0]!, { waitUntil: 'commit' });
      await page.waitForFunction(() => !!(window as any).scene && !!(window as any).overview);
      assert.deepEqual(await page.evaluate(() => {
        const css = getComputedStyle(document.documentElement);
        return { top: css.getPropertyValue('--safe-layout-inset-top').trim(), bottom: css.getPropertyValue('--safe-layout-inset-bottom').trim() };
      }), { top: '20px', bottom: '34px' }, 'exercise the real safe-area context');
      assert.equal(await page.evaluate(() => typeof (document.body as any).moveBefore === 'function'), placement === 'atomic', 'placement path must really be selected');
      assert.equal(await page.evaluate(() => typeof document.body.showPopover === 'function'), true, 'native popover support required for actual flight');
      await page.evaluate(() => document.fonts.ready);
      // Open after Shell hydration, matching smoke-tab-overview's fixture setup.
      await page.evaluate(() => (window as any).toolFixture.panels.open('scope', 'sidechat', { id: 'sidechat:side-preview', resource: 'side-preview', title: 'Side chat', pending: false }));
      // Warm resources via the real overview, then establish an explicit origin.
      await openOverview(page);
      await page.locator('.panel-overview-card[data-tab-kind="sidechat"] .ui-object-title-button').tap();
      await page.waitForFunction(() => !(window as any).overview.open && (window as any).overview.chromeOpacity.get() === 1);
      await page.locator('.side-chat-panel .opencraft-composer-editor').waitFor({ state: 'attached' });
      await openOverview(page);
      await page.locator('.panel-overview-primary .ui-object-title-button').tap();
      await page.waitForFunction(() => !(window as any).overview.open && (window as any).overview.chromeOpacity.get() === 1);
      await page.locator('[data-tool-file] .cm-content').waitFor({ state: 'attached' });
      await page.locator('[data-tool-terminal] .xterm-screen').waitFor({ state: 'attached' });
      await page.locator('.side-chat-panel .opencraft-composer-editor').waitFor({ state: 'attached' });
      await page.getByLabel('Primary draft').fill('Keep tool handoff draft');
      if (source === 'other-tool' || source === 'wide') {
        await openOverview(page);
        await page.locator(`.panel-overview-card[data-tab-kind="${target.origin}"] .ui-object-title-button`).tap();
        await page.waitForFunction(() => !(window as any).overview.open && (window as any).overview.chromeOpacity.get() === 1);
      }
      if (source === 'wide') {
        await page.setViewportSize({ width: 1280, height: 844 });
        await page.evaluate(() => {
          const w = window as any, panels = w.toolFixture.panels;
          if (panels.getOwnerSnapshot('scope').rightPanelFullWidth) panels.dispatch('scope', { type: 'toggle-right-full-width' });
          w.scene.selectPrimary();
        });
        await page.waitForFunction(() => (window as any).scene.contentPresentation === 'split');
        // Wait for the actual Shell allocation to settle before measuring the
        // source. A wide viewport alone does not establish a split scene.
        await page.locator('.right-panel-view').evaluate(async node => {
          let previous = '', stable = 0;
          for (let i = 0; i < 120 && stable < 4; i++) {
            await new Promise(requestAnimationFrame);
            const r = node.getBoundingClientRect(), next = [r.x, r.y, r.width, r.height].join(',');
            stable = next === previous ? stable + 1 : 0; previous = next;
          }
        });
        const split = await page.evaluate(() => {
          const primary = document.querySelector('.main-content-slot')!.getBoundingClientRect();
          const tool = document.querySelector('.right-panel-view')!.getBoundingClientRect();
          return { primary: primary.toJSON(), tool: tool.toJSON(), width: innerWidth, scene: (window as any).scene.contentPresentation };
        });
        assert.equal(split.scene, 'split');
        assert(split.primary.width > 0 && split.tool.width > 0 && split.primary.right <= split.tool.left + 1 && split.tool.right <= split.width + 1,
          'both source panes must have distinct visible allocations: ' + JSON.stringify(split));
      }
      await frames(page, 3);
      assert.equal(await page.locator('.main-content-surface').getAttribute('data-primary-reading'), null, 'a resident side reader cannot allocate primary transcript bleed');
      await page.evaluate(({ selector, kind }) => {
        const w = window as any;
        const resource = document.querySelector<HTMLElement>(selector);
        const root = resource?.closest<HTMLElement>('[data-retained-view]') ?? resource;
        w.handoffTarget = { resource, root, selector, kind };
        w.identities = {
          terminal: w.toolFixture.terminals.get('terminal'), terminalScreen: document.querySelector('[data-tool-terminal] .xterm-screen'),
          file: document.querySelector('[data-tool-file]'), fileEditor: document.querySelector('[data-tool-file] .cm-content'),
          side: document.querySelector('.side-chat-panel'), sideEditor: document.querySelector('.side-chat-panel .opencraft-composer-editor'),
          primary: document.querySelector('[data-tool-primary]'), primaryDraft: document.querySelector('[aria-label="Primary draft"]'),
          iframe: document.querySelector('[data-tool-primary] iframe'), frameWindow: (document.querySelector('[data-tool-primary] iframe') as HTMLIFrameElement).contentWindow,
          counts: { ...w.toolFixture.counts }, reads: w.toolFixture.fileReads(), sideState: w.sidePreview.inspect(),
        };
        w.handoffs = []; w.handoffFrames = []; w.playbacks = []; w.flightFrames = []; w.capturing = true;
        w.readToolHandoff = (phase: string, extra?: any) => {
          const resource = document.querySelector<HTMLElement>(selector);
          const root = resource?.closest<HTMLElement>('[data-retained-view]') ?? resource;
          const view = document.querySelector<HTMLElement>('.right-panel-view')!;
          const box = (element?: HTMLElement | null) => element?.getBoundingClientRect().toJSON() ?? null;
          return { phase, at: performance.now(), extra, view: box(view), root: box(root), resource: box(resource),
            sourceSize: root ? { width: root.clientWidth, height: root.clientHeight } : null,
            borrowed: root?.dataset.retainedPreview === 'true', presentation: root?.dataset.retainedPreviewPresentation,
            rootIdentity: root === w.handoffTarget.root, resourceIdentity: resource === w.handoffTarget.resource };
        };
        w.toolPlaybackProbe = (extra: any) => {
          if (!extra.entering) w.playbacks.push({ ...extra, at: performance.now(), acknowledgedAt: w.browserAcknowledgedAt });
        };
        w.toolHandoffProbe = (phase: string, extra: any) => {
          if (JSON.parse(extra.key)[2] !== (kind === 'resource' ? 'file' : kind === 'sidechat' ? 'sidechat:side-preview' : kind)) return;
          w.handoffs.push(w.readToolHandoff(phase, extra));
          if (phase === 'after') w.handedBack = true;
        };
        const sample = () => {
          if (!w.capturing) return;
          if (w.handedBack) w.handoffFrames.push(w.readToolHandoff('frame'));
          const frame = document.querySelector<HTMLElement>('[data-overview-flight]');
          if (frame) w.flightFrames.push({ at: performance.now(), phase: frame.closest('[data-overview-phase]')?.getAttribute('data-overview-phase'),
            rect: frame.getBoundingClientRect().toJSON(), opacity: Number(getComputedStyle(frame).opacity) });
          requestAnimationFrame(sample);
        }; requestAnimationFrame(sample);
      }, target);
      await openOverview(page);
      if (source === 'other-tool' || source === 'wide') {
        await page.setViewportSize({ width: source === 'wide' ? 1100 : 460, height: source === 'wide' ? 780 : 760 });
        await frames(page, 4);
        if (source === 'wide') assert.equal(await page.evaluate(() => (window as any).scene.contentPresentation), 'split', 'resized overview retains a real split destination');
      }
      const card = page.locator(`.panel-overview-card[data-tab-kind="${target.kind}"]`);
      await card.scrollIntoViewIfNeeded(); await frames(page, 3);
      if (target.kind !== 'browser') {
        const presentation = await page.locator(target.selector).evaluate(node => node.closest<HTMLElement>('[data-retained-view]')?.dataset.retainedPreviewPresentation);
        assert.equal(presentation === 'popover', placement === 'popover', 'retained content must use requested physical placement');
      } else {
        await card.locator('img').waitFor();
        assert(await card.locator('img').evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0), 'browser raster must be decoded');
        await page.evaluate(() => { const w = window as any; w.holdBrowserPresentation = true; w.browserAcknowledgedAt = null; });
      }
      await card.locator('.ui-object-title-button').tap();
      if (target.kind === 'browser') {
        await page.waitForFunction(() => !!(window as any).releaseBrowserPresentation && !!document.querySelector('[data-overview-phase="preparing"]'));
        await page.evaluate(() => { const w = window as any; w.handoffTarget.resource = document.querySelector('[data-tool-browser]'); w.handoffTarget.root = w.handoffTarget.resource; });
        if (source === 'preparing-resize') await page.setViewportSize({ width: 460, height: 760 });
        await frames(page, 8);
        const pending = await page.evaluate(() => ({ open: (window as any).overview.open, playbacks: (window as any).playbacks, handoffs: (window as any).handoffs,
          rect: document.querySelector('[data-overview-flight]')?.getBoundingClientRect().toJSON() }));
        assert(pending.open && pending.rect, 'raster remains a live transition cover while renderer prepares');
        assert.equal(pending.playbacks.length, 0, 'no expansion playback before renderer acknowledgment');
        assert.equal(pending.handoffs.length, 0, 'no handback before renderer acknowledgment');
        await page.evaluate(() => (window as any).releaseBrowserPresentation());
      }
      await page.waitForFunction(() => !(window as any).overview.open && (window as any).overview.chromeOpacity.get() === 1);
      // Include the CSS/observer tail where a second resize could start.
      await page.waitForTimeout(350); await frames(page, 12);
      capture = await page.evaluate(() => {
        const w = window as any; w.capturing = false; const i = w.identities;
        return { handoffs: w.handoffs, frames: w.handoffFrames, playbacks: w.playbacks, flightFrames: w.flightFrames,
          browserAcknowledgedAt: w.browserAcknowledgedAt,
          identities: {
            terminal: i.terminal === w.toolFixture.terminals.get('terminal'), terminalScreen: i.terminalScreen === document.querySelector('[data-tool-terminal] .xterm-screen'),
            file: i.file === document.querySelector('[data-tool-file]'), fileEditor: i.fileEditor === document.querySelector('[data-tool-file] .cm-content'),
            side: i.side === document.querySelector('.side-chat-panel'), sideEditor: i.sideEditor === document.querySelector('.side-chat-panel .opencraft-composer-editor'),
            primary: i.primary === document.querySelector('[data-tool-primary]'), primaryDraft: i.primaryDraft === document.querySelector('[aria-label="Primary draft"]'),
            iframe: i.iframe === document.querySelector('[data-tool-primary] iframe'), frameWindow: i.frameWindow === i.iframe.contentWindow,
          }, before: { counts: i.counts, reads: i.reads, side: i.sideState },
          after: { counts: { ...w.toolFixture.counts }, reads: w.toolFixture.fileReads(), side: w.sidePreview.inspect() },
          primaryDraft: (document.querySelector('[aria-label="Primary draft"]') as HTMLInputElement).value,
        };
      });
      const before = capture.handoffs.find((entry: any) => entry.phase === 'before');
      const after = capture.handoffs.find((entry: any) => entry.phase === 'after');
      assert(before && after && capture.frames.length >= 12, 'must observe the actual handback and later frames');
      const near = (a: number, b: number, description: string) => {
        if (Math.abs(a - b) > 1) faults.push(`${description}: ${a} != ${b}`);
      };
      for (const axis of ['x', 'y', 'width', 'height']) {
        near(before.extra.scene[axis], after.view[axis], 'flight endpoint vs actual destination ' + axis);
        near(capture.playbacks[0].scene[axis], after.view[axis], 'prepared playback destination vs final view ' + axis);
        near(before.root[axis], after.root[axis], 'no source bounds change at handback ' + axis);
        near(before.resource[axis], after.resource[axis], 'no resource bounds change at handback ' + axis);
        for (const frame of capture.frames) {
          near(frame.view[axis], after.view[axis], 'no late destination resize ' + axis);
          near(frame.root[axis], after.root[axis], 'no late source resize ' + axis);
          near(frame.resource[axis], after.resource[axis], 'no late resource resize ' + axis);
        }
      }
      for (const axis of ['width', 'height']) near(before.sourceSize[axis], after.sourceSize[axis], 'no second layout size ' + axis);
      assert.equal(capture.playbacks.length, 1, 'one real expansion driver');
      assert(capture.flightFrames.length > 3, 'must paint real intermediate flight frames');
      assert(Object.values(capture.identities).every(Boolean), 'resource and draft DOM identities survive');
      assert.deepEqual(capture.after, capture.before, 'no resource remounts, reloads, side draft/subscription changes or duplicate previews');
      assert.equal(capture.primaryDraft, 'Keep tool handoff draft');
      assert.equal(after.borrowed, false, 'selected source released from overview');
      assert(after.rootIdentity && after.resourceIdentity, 'selected destination identity survives handback');
      if (target.kind === 'browser') {
        assert.equal(before.extra.raster, true, 'exercise actual raster handback');
        assert(capture.playbacks[0].at >= capture.browserAcknowledgedAt, 'acknowledgment must precede expansion flight');
        for (const axis of ['x', 'y', 'width', 'height']) near(capture.playbacks[0].scene[axis], after.view[axis], 'acknowledged raster destination vs final bounds ' + axis);
      } else assert.equal(before.extra.raster, false, 'exercise actual retained handback');
      assert.deepEqual(errors, []);
      await writeFile(resolve(output, label + '.json'), JSON.stringify({ label, faults, errors, ...capture }, null, 2));
      assert.deepEqual(faults, [], label);
      console.log('PASS', label);
    } catch (error) {
      faults.push(error instanceof Error ? error.message : String(error));
      console.error('FAIL', label, faults[0], errors);
      console.error(error instanceof Error ? error.stack : error);
      console.error('FIXTURE', await page.evaluate(() => ({ tabs: (window as any).toolFixture?.panels.getOwnerSnapshot('scope'),
        side: (window as any).sidePreview?.inspect(), composers: [...document.querySelectorAll('.opencraft-composer-editor')].map(node => node.outerHTML.slice(0, 180)),
        sidePresent: !!document.querySelector('.side-chat-panel') })).catch(() => null));
      await writeFile(resolve(output, label + '.json'), JSON.stringify({ label, faults, errors, ...capture }, null, 2));
      await page.screenshot({ path: resolve(output, label + '-failed.png'), timeout: 5000 }).catch(() => {});
    } finally {
      results.push({ label, passed: faults.length === 0, faults, errors });
      await writeFile(resolve(output, 'receipt.json'), JSON.stringify({ passed: results.every(result => result.passed), cases: results }, null, 2));
      await page.close();
    }
  }
  assert(results.length > 0, 'source filter must select at least one real case');
  assert.equal(results.filter(result => !result.passed).length, 0, 'tool handoff failures: see ' + resolve(output, 'receipt.json'));
} finally { await browser?.close(); await vite.close(); }
