import assert from "node:assert/strict";
import { createServer } from "vite";
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] }, server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "rail", configureServer(server) { server.middlewares.use((req, res, next) => { if (!req.url?.startsWith("/?")) return next(); res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/touch-newera.tsx"></script>'); }); } }] });
const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
let browser: any;
try {
 await vite.listen(); browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });

 const quick = process.argv.includes("--quick");
 for (const width of quick ? [390] : [320, 390, 1280]) for (const palette of quick ? ["neutral"] : ["neutral", "canvas", "frost", "lavender", "mist", "graphite"]) for (const mode of ["light", "dark"]) {
  console.log(`Checking ${width}/${palette}/${mode}`);
  const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: true });
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.addInitScript("window.__name=value=>value");
  await page.goto(`${vite.resolvedUrls!.local[0]}?palette=${palette}&mode=${mode}`);
  const editor = page.locator('.opencraft-composer-editor'); await editor.waitFor();
  await page.evaluate(() => (window as any).setTouch(true));
  const shape = () => page.locator('.opencraft-composer-shell').evaluate((n: HTMLElement) => ({height:n.getBoundingClientRect().height, width:n.getBoundingClientRect().width, background:getComputedStyle(n, "::before").backgroundColor, radius:getComputedStyle(n).borderRadius, blur:getComputedStyle(n, "::before").backdropFilter, overflow:document.documentElement.scrollWidth > innerWidth}));
  await page.waitForTimeout(100); const original = await shape();
  await page.evaluate(() => (window as any).setNewera(true)); await page.waitForTimeout(100);
  const compact = await shape(); assert(compact.height <= 60, JSON.stringify(compact)); assert.equal(compact.radius, "28px"); assert(compact.blur.includes("20px")); assert(!compact.overflow);
  const circles = page.locator('.opencraft-composer-icon-button:visible, .opencraft-composer-submit:visible');
  for (const button of await circles.all()) {
    assert(await button.evaluate((node: HTMLElement) => {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      const center = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      const corner = document.elementFromPoint(rect.x + 1, rect.y + 1);
      return rect.width >= 44 && rect.height === rect.width && style.borderRadius === '50%'
        && (center === node || node.contains(center)) && corner !== node && !node.contains(corner);
    }), 'visible icon and true hit region are circular, including microphone and send');
  }
  assert.equal(await page.locator('.thread-scroll-footer__gradient').evaluate((node: HTMLElement) => getComputedStyle(node).backgroundImage), 'none');
  assert.equal(await page.locator('.thread-scroll-footer').evaluate((node: HTMLElement) =>
    getComputedStyle(node, '::after').content), 'none',
    'touch safe area stays open beneath the floating Composer');
  assert(compact.background.includes('0.62'), compact.background);
  const shell = page.locator('.opencraft-composer-shell');
  const glassBefore = await shell.screenshot();
  await page.locator('[aria-hidden]').first().evaluate((node: HTMLElement) => { node.style.background = 'rgb(220,40,80)'; });
  const glassAfter = await shell.screenshot();
  assert(!glassBefore.equals(glassAfter), 'backdrop changes must be visible through the glass');
  await page.locator('[aria-hidden]').first().evaluate((node: HTMLElement) => { node.style.background = ''; });
  await page.evaluate(() => (window as any).setQueue(true));
  const rail = page.locator('.opencraft-composer-attached-rail'); await rail.waitFor();
  const railMaterial = await rail.evaluate((node: HTMLElement) => {
    const style = getComputedStyle(node, '::before');
    return {background:style.backgroundColor, blur:style.backdropFilter, hit:style.pointerEvents, ownerFilter:getComputedStyle(node).backdropFilter};
  });
  assert(railMaterial.background.includes('0.94'), 'queue glass is independent of editor tint');
  assert.equal(railMaterial.blur, compact.blur, 'queue and editor share blur');
  assert.equal(railMaterial.hit, 'none'); assert.equal(railMaterial.ownerFilter, 'none');
  await page.waitForTimeout(220); // Existing tray entrance animation has completed.
  const railBefore = await rail.screenshot();
  await page.locator('[aria-hidden]').first().evaluate((node: HTMLElement) => { node.style.background = 'rgb(220,40,80)'; });
  const railAfter = await rail.screenshot();
  assert(!railBefore.equals(railAfter), 'scrolling backdrop must show through queue glass too');
  await page.locator('[aria-hidden]').first().evaluate((node: HTMLElement) => { node.style.background = ''; });
  if (width === 390 && palette === 'neutral') await page.locator('.opencraft-composer-stack').screenshot({path:`/tmp/newera-rail-${mode}.png`});
  if (width === 390 && palette === 'neutral') {
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-transparency',value:'reduce'}]});
    assert(await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches));
    const fallback = await rail.evaluate((node: HTMLElement) => {
      const editor = node.parentElement!.querySelector('.opencraft-composer-shell')!;
      return {rail:getComputedStyle(node,'::before').backgroundColor,editor:getComputedStyle(editor,'::before').backgroundColor,railBlur:getComputedStyle(node,'::before').backdropFilter,editorBlur:getComputedStyle(editor,'::before').backdropFilter};
    });
    assert(!fallback.editor.includes('0.62')); assert.equal(fallback.railBlur,'none'); assert.equal(fallback.editorBlur,'none');
    assert(!fallback.rail.includes('0.94'), 'reduced transparency falls back to opaque');
    await session.send('Emulation.setEmulatedMedia', {features:[]});
    await page.evaluate(() => (window as any).setNewera(false));
    const ordinary = await rail.evaluate((node: HTMLElement) => ({content:getComputedStyle(node,'::before').content,background:getComputedStyle(node).backgroundColor}));
    assert.equal(ordinary.content,'""'); assert.equal(ordinary.background,'rgba(0, 0, 0, 0)', 'rail glass remains enabled outside Newera');
    await page.evaluate(() => (window as any).setNewera(true));
    await session.detach();
  }
  await page.evaluate(() => (window as any).setQueue(false));
  await rail.waitFor({state:'hidden'});
  const same = await editor.elementHandle();
  await editor.click();
  const expanding = await shell.evaluate((node: HTMLElement) => node.getAnimations().filter(animation => animation.id === "newera-focus-expansion").length);
  assert.equal(expanding, 0, 'empty focus has no geometry animation');
  await page.waitForTimeout(220);
  assert((await shape()).height > compact.height + 20, 'editor focus opens the normal footer');
  await editor.evaluate((node: HTMLElement) => node.blur());
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.opencraft-composer-stack')?.dataset.composerEditing === 'false');
  assert.equal((await shape()).height, compact.height, 'empty blur returns to one row');
  assert.equal(await page.getByRole('button', { name: '更多输入选项', exact: true }).count(), 0, 'no manual expansion toggle');
  await editor.click(); await page.waitForTimeout(220);
  await page.getByRole('button', { name: 'Fixture microphone', exact: true }).focus();
  assert((await shape()).height > compact.height + 20, 'toolbar focus retains the editing session');
  assert.equal(await page.locator('.opencraft-composer-shortcut-trigger').count(), 0, 'slash commands have no separate footer menu');
  await editor.fill('/he');
  await page.getByRole('listbox').waitFor();
  assert((await shape()).height > compact.height + 20, 'inline command suggestions retain the editing session');
  await page.keyboard.press('Escape');

  await editor.fill('保留当前草稿'); await page.waitForTimeout(100);
  assert((await shape()).height > compact.height + 20, 'content expands');
  await page.evaluate(() => (window as any).setNewera(false));
  assert.equal(await editor.innerText(), '保留当前草稿');
  assert(await same!.evaluate((n: Node) => n === document.querySelector('.opencraft-composer-editor')), 'same editor node across mode changes');
  await editor.click();
  await editor.press('ControlOrMeta+A');
  await editor.press('Backspace');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.opencraft-composer-stack')?.dataset.composerEmpty === 'true');
  await page.evaluate(() => (window as any).setNewera(true)); await page.waitForTimeout(220);
  await editor.evaluate((node: HTMLElement) => node.blur());
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.opencraft-composer-stack')?.dataset.composerEditing === 'false');
  assert.equal((await shape()).height, compact.height, JSON.stringify(await page.locator(".opencraft-composer-stack").evaluate((n: HTMLElement) => ({...n.dataset, text:n.querySelector(".opencraft-composer-editor")?.textContent}))));
  await page.evaluate(() => (window as any).setTouch(false)); await page.waitForTimeout(100);
  assert((await shape()).radius !== "28px", 'compact layout ignores Newera');
  await page.evaluate(() => (window as any).setTouch(true)); await page.waitForTimeout(80);
  const toggle = page.getByRole('switch', { name: '触控端 Newera 体验', exact: true });
  assert.equal(await toggle.getAttribute('aria-checked'), 'true'); await toggle.click(); await page.waitForTimeout(80);
  assert.equal(await page.locator('html').getAttribute('data-touch-newera'), 'off');
  await toggle.click(); await page.waitForTimeout(80);
  if (width === 390 && palette === 'neutral' && mode === 'light') {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await editor.click();
    assert((await shape()).height > compact.height + 20, 'reduced motion preserves focus expansion');
    assert.equal(await shell.evaluate((node: HTMLElement) => node.getAnimations().filter(animation => animation.id === "newera-focus-expansion").length), 0);
    await editor.evaluate((node: HTMLElement) => node.blur());
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  }
  if (width === 390) await page.screenshot({ path: `/tmp/newera-${palette}-${mode}.png` });
  assert(original.height > compact.height); assert.deepEqual(errors, []); await page.close();
 }
 console.log(`PASS: Newera ${quick ? 2 : 36} theme/layout combinations; round hit regions/glass pixel change/empty focus expansion/no toggle/toolbar continuity/type/clear/off/compact; same editor and draft; real Settings toggle; queue glass and accessibility fallback`);
} finally { await browser?.close(); await vite.close(); }
