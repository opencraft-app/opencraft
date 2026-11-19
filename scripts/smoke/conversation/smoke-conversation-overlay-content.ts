import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from "vite";
import { chromium, _electron } from "playwright";
const historyMode = process.argv.includes('--history');
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/opencraft-overlay-content";
await mkdir(output, { recursive: true });
const vite = await createServer({ root: process.cwd(), configFile: false, logLevel: "error", esbuild: { jsx: "automatic" },
  optimizeDeps: { include: ["react", "react-dom/client", "@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-popover", "@tanstack/react-query"] },
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-overlay-content",
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "overlay-content", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/" && !request.url?.startsWith("/?")) return next();
      response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/conversation-overlay-content.tsx"></script>');
    });
  } }] });
await vite.listen();
const electronDirectory = process.env.OPENCRAFT_ELECTRON_EXECUTABLE ? await mkdtemp(join(tmpdir(), 'opencraft-history-smoke-')) : null;
if (electronDirectory) await writeFile(join(electronDirectory, 'app.cjs'), "const {app,BrowserWindow}=require('electron');app.setPath('userData',require('node:path').join(__dirname,'profile'));app.whenReady().then(()=>new BrowserWindow({show:true,width:1280,height:900,webPreferences:{sandbox:true}}).loadURL('about:blank'));");
const env = { ...process.env }; for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'DISPLAY', 'WAYLAND_DISPLAY']) delete env[key];
const electron = electronDirectory ? await _electron.launch({ executablePath: process.env.OPENCRAFT_ELECTRON_EXECUTABLE,
  args: ['--ozone-platform=headless', '--ozone-override-screen-size=1920,1080', '--disable-gpu', join(electronDirectory, 'app.cjs')], env }) : null;
const browser = electron ? null : await chromium.launch({ headless: true, ...(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE } : {}), args: ["--no-sandbox"] });
try {
  for (const touch of process.argv.includes('--touch-only') ? [true] : process.argv.includes('--pointer-only') ? [false] : [false, true]) {
    console.log("overlay content", touch ? "touch" : "pointer");
    const viewport = { width: touch ? 390 : 1280, height: 900 };
    const page = electron ? await electron.firstWindow() : await browser!.newPage({ viewport, hasTouch: touch, isMobile: touch });
    if (electron) {
      await page.setViewportSize(viewport);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: touch });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
    }
    const errors: string[] = [];
    const activate = async (locator: import('playwright').Locator) => {
      if (!touch) return locator.click();
      if (!electron) return locator.tap();
      await locator.waitFor({ state: 'visible' });
      const bounds = (await locator.boundingBox())!, cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    };
    page.on("pageerror", error => { errors.push(error.message); console.error('page error', error.message); });
    page.setDefaultNavigationTimeout(120_000); await page.goto(vite.resolvedUrls!.local[0]! + `?${touch ? 'touch&' : ''}${historyMode ? 'history' : ''}`);
    await page.locator(".opencraft-composer-editor").fill("Same thread draft");
    if (historyMode) {
      await page.evaluate(() => { (window as any).originalDraft = document.querySelector('.opencraft-composer-editor'); (window as any).overlayProbe.setOverlay(true); });
      if (touch) await activate(page.getByRole('button', { name: 'Agent', exact: true }));
      else await page.locator('.opencraft-composer-editor').focus();
      const summary = page.locator('.thread-composer-overlay__summary');
      await summary.waitFor();
      if (await summary.getAttribute('aria-expanded') !== 'true') await activate(summary);
      const response = page.locator('.thread-composer-overlay__response'), scroll = response.locator('.thread-scroll');
      await response.getByText('Question 59', { exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('.thread-composer-overlay')?.getAttribute('data-transition-state') === 'visible');
      await page.waitForTimeout(250);
      await scroll.evaluate(element => { element.scrollTop = -600; });
      await page.waitForTimeout(250);
      const capture = () => scroll.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const row = Array.from(element.querySelectorAll<HTMLElement>('.thread-virtualizer-row')).find(row => row.getBoundingClientRect().bottom > bounds.top + 1);
        return { key: row?.dataset.turnKey ?? row?.querySelector('[data-turn-key]')?.getAttribute('data-turn-key'), top: row ? row.getBoundingClientRect().top - bounds.top : null, distance: -element.scrollTop };
      });
      const before = await capture(); assert.ok(before.key, 'a historical row is visible');
      await page.evaluate(() => (window as any).overlayProbe.appendRound());
      await page.waitForTimeout(250);
      const after = await capture(); assert.equal(after.key, before.key); assert.ok(Math.abs(after.top! - before.top!) <= 2, 'new turn preserves the reading anchor');
      await summary.click(); await page.waitForTimeout(250);
      await summary.click(); await scroll.waitFor(); await page.waitForTimeout(250);
      const reopened = await capture(); assert.equal(reopened.key, after.key); assert.ok(Math.abs(reopened.top! - after.top!) <= 2, 'reopening preserves reading position');
      await page.evaluate(() => (window as any).overlayProbe.setTool('terminal:two'));
      await page.waitForTimeout(250);
      if (touch && await page.getByRole('button', { name: 'Agent', exact: true }).getAttribute('aria-pressed') !== 'true') await activate(page.getByRole('button', { name: 'Agent', exact: true }));
      if (!touch) await page.locator('.opencraft-composer-editor').focus();
      await summary.waitFor();
      if (await summary.getAttribute('aria-expanded') !== 'true') await activate(summary);
      await scroll.waitFor(); await page.waitForTimeout(250);
      const switched = await capture(); assert.equal(switched.key, reopened.key); assert.ok(Math.abs(switched.top! - reopened.top!) <= 2, 'tool switch preserves history reading position');
      const bottom = response.getByRole('button', { name: 'Back to latest', exact: true });
      await bottom.click(); await response.getByText('Question 60', { exact: true }).waitFor();
      await page.waitForFunction(() => Math.abs(document.querySelector('.thread-composer-overlay__response .thread-scroll')!.scrollTop) < 1);
      for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
        const previous = await page.evaluate(() => (window as any).overlayProbe.start);
        console.log('history page', touch ? 'touch' : 'pointer', pageIndex, previous);
        await scroll.evaluate(element => { element.scrollTop = -element.scrollHeight; });
        await page.waitForTimeout(100);
        if (touch) {
          const bounds = (await scroll.boundingBox())!, cdp = await page.context().newCDPSession(page);
          const x = bounds.x + bounds.width / 2, y = bounds.y + 30;
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 80 }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await cdp.detach();
        } else { await scroll.hover(); await page.mouse.wheel(0, -100); }
        await page.waitForFunction(previous => (window as any).overlayProbe.start < previous, previous);
        await page.waitForTimeout(150);
      }
      assert.equal(await page.evaluate(() => (window as any).overlayProbe.start), 0);
      await scroll.evaluate(element => { element.scrollTop = -element.scrollHeight; });
      await response.getByText('Question 0', { exact: true }).waitFor();
      assert.ok((await page.evaluate(() => (window as any).overlayProbe.requests)).every((surface: string) => surface === 'overlay'), 'parked main surface does not load history');
      assert.ok(await response.locator('.thread-virtualizer-row').count() < 30, 'long history uses a bounded mounted window');
      await page.screenshot({ path: `${output}/${touch ? 'touch' : 'pointer'}-history.png` });
      await page.evaluate(() => (window as any).overlayProbe.setOverlay(false));
      assert.equal(await page.locator('.opencraft-composer-editor').innerText(), 'Same thread draft');
      assert.ok(await page.locator('.opencraft-composer-editor').evaluate(element => element === (window as any).originalDraft));
      assert.deepEqual(errors, []);
      if (!electron) await page.close();
      continue;
    }
    const first = page.locator('[data-conversation-content-key]').first();
    await first.evaluate(element => element.scrollIntoView({ block: "center" }));
    await page.getByText("Thought 0", { exact: true }).waitFor();
    await page.evaluate(() => { (window as any).originalDraft = document.querySelector('.opencraft-composer-editor'); (window as any).overlayProbe.setOverlay(true); });
    if (touch) await activate(page.getByRole('button', { name: 'Agent', exact: true }));
    const summary = page.locator('.thread-composer-overlay__summary');
    await summary.waitFor();
    if (await summary.getAttribute('aria-expanded') !== 'true') await activate(summary);
    const response = page.locator('.thread-composer-overlay__response .thread-scroll');
    await response.waitFor();
    await response.evaluate(element => { element.scrollTop = -element.scrollHeight; });
    // The main timeline's observer root is not an ancestor of the portalled reply.
    // Its placeholders must not replace visible process rows in this scrollport.
    await response.getByText("Thought 0", { exact: true }).waitFor({ timeout: 5000 });
    assert(await response.getByText('Ran echo activity-0', { exact: true }).count() || await response.getByText(/activity-0/).count());
    for (let step = 0; step < 150 && !await response.getByText("Visible commentary in the same thread", { exact: true }).isVisible(); step++) {
      await response.evaluate(element => { element.scrollTop += element.clientHeight / 2; });
      await page.waitForTimeout(30);
    }
    await response.getByText("Visible commentary in the same thread", { exact: true }).waitFor();
    for (let step = 0; step < 10; step++) {
      await response.evaluate(element => { element.scrollTop = 0; });
      await page.waitForTimeout(50);
    }
    await response.getByText("Ran echo activity-99", { exact: true }).waitFor();
    await page.evaluate(() => (window as any).overlayProbe.append());
    await response.evaluate(element => { element.scrollTop = 0; });
    await response.getByText("Ran echo activity-100", { exact: true }).waitFor();
    await page.waitForTimeout(250);
    const bounds = await response.boundingBox();
    assert(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 900, "reply stays inside the viewport");
    if (touch) assert.equal(await page.locator('.thread-composer-overlay-host').getAttribute('data-mobile-panel'), 'true');
    await page.screenshot({ path: `${output}/${touch ? "touch" : "pointer"}.png` });
    await page.evaluate(() => (window as any).overlayProbe.setOverlay(false));
    const draft = page.locator(".opencraft-composer-editor");
    assert.equal(await draft.innerText(), 'Same thread draft');
    assert(await draft.evaluate(element => element === (window as any).originalDraft));
    assert.deepEqual(errors, []);
    if (!electron) await page.close();
  }
  await writeFile(`${output}/result.json`, JSON.stringify(historyMode
    ? { result: 'passed', sameThread: true, allTurns: true, olderPages: 3, virtualized: true, readingAnchorPreserved: true, parkedMainDoesNotLoad: true, draftPreserved: true }
    : { result: "passed", sameThread: true, longActivity: true, streaming: true, draftPreserved: true }));
} catch (error) {
  for (const page of electron?.context().pages() ?? browser?.contexts().flatMap(context => context.pages()) ?? []) {
    console.error('failed history state', await page.evaluate(() => ({ probe: (window as any).overlayProbe && { start: (window as any).overlayProbe.start, requests: (window as any).overlayProbe.requests }, scrolls: Array.from(document.querySelectorAll('.thread-scroll')).map(element => ({ height: element.clientHeight, scrollHeight: element.scrollHeight, top: element.scrollTop })), text: document.body.innerText.slice(-1000) })));
    await page.screenshot({ path: `${output}/failed.png`, timeout: 5000 }).catch(() => {});
  }
  throw error;
} finally { await electron?.close(); await browser?.close(); await vite.close(); if (electronDirectory) await rm(electronDirectory, { recursive: true, force: true }); }
