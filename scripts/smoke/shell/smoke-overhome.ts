import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const hostless = process.argv.includes("--hostless");
const motionOnly = process.argv.includes("--motion-only");
const output = process.env.OPENCRAFT_OVERHOME_OUTPUT ?? (hostless ? ".local/overhome-hostless" : ".local/overhome");
const source = `
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createWebWorkbenchApplication,WorkbenchRoot} from '/apps/workbench-web/src/workbench-root.tsx';
import {initializeAppearanceTheme,setThemePreference,setAppearanceThemeId,coreThemeId,longingThemeId} from '/apps/workbench-web/src/appearance-theme.ts';
import {createSmokeClientProduct} from '/tests/fixtures/client-product.ts';
import {OVERHOME_VIEW_ID} from '/apps/workbench-web/src/runtime/mini-apps.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
if (!${hostless}) { const config=document.createElement('script');config.id='opencraft-deployment-config';config.type='application/json';config.textContent=JSON.stringify({hosts:[{hostId:'fixture-host',label:'Fixture Host',kind:'remote-ssh',url:location.origin.replace('http','ws')+'/fixture-rpc'}],builtinAgents:false,hypernode:false});document.head.append(config); }
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory',clientProduct:createSmokeClientProduct([],false)});
const supervisor=application.supervisor,nav=supervisor.navigation;
createIntlTestRoot(document.getElementById('app'),undefined,'zh-CN').render(<WorkbenchRoot application={application}/>);
window.proof={route:()=>nav.getSnapshot(),open:()=>nav.openExtensionView(OVERHOME_VIEW_ID),chat:()=>nav.openChat(),back:()=>nav.back(),forward:()=>nav.forward(),
theme:setThemePreference,appearance:setAppearanceThemeId,themes:[coreThemeId,longingThemeId],retireLong:()=>supervisor.extensions.deactivate('example.long'),retire:()=>supervisor.extensions.deactivate('opencraft.schedules'),
longLabel:async()=>supervisor.extensions.activate({manifest:{manifestVersion:1,id:'example.long',name:'Long label fixture',version:'1.0.0',apiVersion:1,trust:'trusted',platforms:['web'],activationEvents:['onStartupFinished']},activate(api){
 api.views.register({id:'example.long.view',title:'Long label',viewType:'example.long'});
 api.navigation.register({id:'example.long.app',title:'一个名称很长的应用用于检查多行文本和触控目标',surface:'applications',target:{kind:'view',viewId:'example.long.view'},icon:'calendar'});
 api.internal.register('platformViewRenderer',{viewType:'example.long',Component:()=>React.createElement('p',null,'Long label fixture')});
}})};
document.body.dataset.ready='true';
`;
const vite = await createServer({ configFile: false, root: process.cwd(), cacheDir: output + "/vite-cache", publicDir: "apps/workbench-web/public", logLevel: "error",
  optimizeDeps: { include: ["@opencraft/remote-interaction", "@opencraft/remote-interaction/touch", "@opencraft/remote-interaction/websocket"] },
  define: { "import.meta.env.VITE_OPENCRAFT_PRESENTATION": JSON.stringify(JSON.stringify({ iconStyle: "classic" })), "process.env.NEXT_PUBLIC_REGION": '"cn"', "process.env.NEXT_PUBLIC_PREVIEW_LOCALES": '""',
    "import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN": '"false"', "import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN": '"false"' },
  esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "overhome-smoke", resolveId: id => id === "/proof.tsx" ? id : null, load: id => id === "/proof.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((request, response, next) => {
      if (request.url !== "/") return next(); response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="app"></div><script type="module" src="/proof.tsx"></script>');
    }); } }],
});
let browser: any, lastPage: any;
const errors: string[] = [], external: string[] = [], observed: unknown[] = [];
const motionEvidence: Record<string, unknown> = {};
try {
  await vite.listen(); const url = vite.resolvedUrls!.local[0]!, origin = new URL(url).origin;
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  if (!motionOnly) {
  const page = lastPage = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true });
  page.setDefaultTimeout(20000); page.on("pageerror", (error: Error) => { errors.push(error.message); console.error(error.message); });
  await page.addInitScript("window.__name = target => target");
  await page.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : (external.push(route.request().url()), route.abort()));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }); await page.locator('body[data-ready="true"]').waitFor({ timeout: 60000 });
  const showSidebar = async () => {
    const toggle = page.locator('[data-chrome-action-id="sidebar-toggle"]:visible').first();
    if (await toggle.count() && await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  };
  await page.locator('.app-shell-root').waitFor({timeout:60000});
  if (!hostless) {
    const editor = page.locator('[contenteditable="true"]').first(); await editor.waitFor();
    await editor.fill('Keep this unsent Overhome draft');
    await editor.evaluate(element => { (window as any).retainedEditor = element; });
  }
  await showSidebar();
  const launch = async () => {
    const entrance = page.locator('[data-action-id="shell.applications.header"]:visible, [data-action-id="shell.applications"]:visible, .shell-navigation__entrance[data-surface="applications"]:visible').first();
    if (!await entrance.count()) await showSidebar();
    await entrance.tap();
  };
  await launch();
  await page.locator(".overhome").waitFor();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-application-scene="desktop"]')!).transform === "none");
  await page.waitForFunction(() => {
    const bounds = document.querySelector('.overhome')!.getBoundingClientRect();
    return Math.abs(bounds.left) < 1 && Math.abs(bounds.width - innerWidth) < 1;
  });
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: output + "/first-home.png" });
  assert.equal(await page.locator("[data-miniapp-id]").count(), 1);
  assert.equal(await page.locator('[data-miniapp-id="opencraft.schedules.app"] svg circle').count(), 1, "calendar clock artwork survives classic product presentation");
  assert.equal(await page.locator('[data-action-id="opencraft.schedules"]').count(), 0, "no duplicate sidebar launch");
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  await page.locator(".scheduled-tasks-page").waitFor();
  assert.equal((await page.evaluate(() => (window as any).proof.route())).applicationRoute.slug, "opencraft.schedules");
  await page.evaluate(() => (window as any).proof.back()); await page.locator(".overhome").waitFor();
  await page.evaluate(() => (window as any).proof.back()); await page.locator(".overhome").waitFor({ state: "hidden" });
  assert.equal((await page.evaluate(() => (window as any).proof.route())).applicationRoute.kind, "conversation");
  if (!hostless) assert.equal(await page.locator('[contenteditable="true"]').first().evaluate(element =>
    element === (window as any).retainedEditor && element.textContent === 'Keep this unsent Overhome draft'), true);
  await page.evaluate(() => (window as any).proof.forward()); await page.locator(".overhome").waitFor();
  await mkdir(output, { recursive: true });
  for (const appearance of await page.evaluate(() => (window as any).proof.themes)) for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
    await page.evaluate(({ appearance, theme }: any) => { (window as any).proof.appearance(appearance); (window as any).proof.theme(theme); }, { appearance, theme });
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(width => Math.abs(document.querySelector(".app-shell-root")!.getBoundingClientRect().width - width) < 1, width);
    if (width === 390) {
      await page.evaluate(() => (window as any).proof.chat()); await showSidebar();
      await launch();
      await page.locator('.overhome').waitFor();
      if (!hostless) await page.waitForFunction(() => Math.abs(document.querySelector('.overhome')!.getBoundingClientRect().left) < 1);
    }
    const tile = page.locator('[data-miniapp-id="opencraft.schedules.app"]');
    await page.waitForFunction(() => {
      const desktop = document.querySelector('.overhome')!.getBoundingClientRect();
      return Math.abs(desktop.left) < 1 && Math.abs(desktop.width - innerWidth) < 1;
    });
    const shellEdges = await page.evaluate(() =>
      ['.app-shell-header__content-edge', '.app-shell-content-depth', '.main-content-surface'].map(selector =>
        getComputedStyle(document.querySelector(selector)!).boxShadow));
    assert.ok(shellEdges.every(shadow => shadow === 'none'), 'wallpaper has no theme reading-pane shadow below its header');
    const geometry = await tile.evaluate((button: HTMLElement) => {
      const r = button.getBoundingClientRect(), root = document.querySelector(".overhome")!;
      return { width: r.width, height: r.height, x: r.x, right: r.right, overflow: root.scrollWidth > root.clientWidth };
    });
    assert.ok(geometry.width >= 44 && geometry.height >= 44 && geometry.x >= 0 && geometry.right <= width && !geometry.overflow);
    observed.push({ appearance, theme, width, geometry });
    await page.screenshot({ path: `${output}/${appearance}-${theme}-${width}.png` });
    const home = page.locator('[data-chrome-action-id="home"]:visible').first();
    await home.waitFor();
    assert.equal(await home.getAttribute('aria-label'), '首页');
    assert.equal(await page.locator('[data-app-shell-sidebar-trigger="true"]:visible').evaluateAll(elements =>
      elements.filter(element => !element.closest('[inert]')).length), 0,
      'application desktop replaces the sidebar toggle with Home');
    await home.tap();
    await page.waitForFunction(() => (window as any).proof.route().applicationRoute.kind === 'conversation');
    if (!hostless) assert.equal(await page.locator('[contenteditable="true"]').first().evaluate(element =>
      element === (window as any).retainedEditor && element.textContent === 'Keep this unsent Overhome draft'), true,
      'Home restores the remembered conversation and its existing editor');
    await launch(); await page.locator('.overhome').waitFor();
    await tile.tap(); await page.locator(".scheduled-tasks-page").waitFor();
    await page.evaluate(() => (window as any).proof.back()); await page.locator(".overhome").waitFor();
  }
  // Mobile entrance is present by default, independent of the retired preference.
  await page.evaluate(() => (window as any).proof.chat()); await showSidebar();
  await launch(); await page.locator(".overhome").waitFor();
  if (!hostless) await page.locator('[data-action-id="shell.applications.header"]').waitFor({ state: "hidden" });
  const tile = page.locator('[data-miniapp-id="opencraft.schedules.app"]');
  await page.keyboard.press("Tab");
  await tile.focus(); assert.equal(await tile.evaluate(element => element.matches(":focus-visible")), true);
  await page.keyboard.press("Enter"); await page.locator(".scheduled-tasks-page").waitFor();
  await page.evaluate(() => (window as any).proof.back()); await page.locator(".overhome").waitFor();
  await page.evaluate(() => (window as any).proof.longLabel());
  const long = page.locator('[data-miniapp-id="example.long.app"]'); await long.waitFor();
  assert.equal(await long.evaluate(element => element.scrollWidth > element.clientWidth), false);
  await page.screenshot({ path: `${output}/long-label-mobile.png` });
  await page.evaluate(() => (window as any).proof.retire()); await tile.waitFor({ state: "hidden" });
  await page.evaluate(() => (window as any).proof.retireLong());
  await page.locator('.overhome__empty').waitFor(); assert.equal(await page.locator('[data-miniapp-id]').count(), 0);

  }
  // A separate, fresh real App records the interaction itself, not a storyboard.
  const motionContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true,
    recordVideo: { dir: output + "/video", size: { width: 390, height: 844 } } });
  const motionPage = lastPage = await motionContext.newPage();
  motionPage.setDefaultTimeout(20000);
  motionPage.on("pageerror", (error: Error) => errors.push(error.message));
  await motionPage.addInitScript("window.__name = target => target");
  await motionPage.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : (external.push(route.request().url()), route.abort()));
  await motionPage.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }); await motionPage.locator('body[data-ready="true"]').waitFor({ timeout: 60000 });
  await motionPage.locator('.app-shell-root').waitFor();
  if (!hostless) {
    const editor = motionPage.locator('[contenteditable="true"]').first(); await editor.waitFor();
    await editor.fill('Keep my desktop motion draft');
    await editor.evaluate(element => { (window as any).motionEditor = element; });
  }
  await motionPage.evaluate(() => { (window as any).proof.theme("light"); (window as any).proof.open(); });
  const settleDesktop = async () => {
    await motionPage.locator('.overhome').waitFor();
    await motionPage.waitForFunction(() => {
      const scene = document.querySelector('[data-application-scene="desktop"][data-scene-present="true"]');
      const icon = document.querySelector('[data-miniapp-id]');
      return scene && icon && getComputedStyle(scene).transform === 'none' && getComputedStyle(scene).opacity === '1'
        && getComputedStyle(icon.parentElement!).transform === 'none' && document.querySelectorAll('[data-application-scene]').length === 1;
    });
  };
  await settleDesktop();
  await motionPage.screenshot({ path: output + '/home-phone.png' });
  const trace = () => motionPage.evaluate(async () => {
    const frames: { at: number; width: number; x: number; opacity: string; inert: boolean }[] = [];
    const start = performance.now();
    while (performance.now() - start < 850) {
      await new Promise(requestAnimationFrame);
      const window = document.querySelector<HTMLElement>('[data-application-scene="app"]');
      if (window) frames.push({ at: performance.now() - start, width: window.getBoundingClientRect().width,
        x: window.getBoundingClientRect().left, opacity: getComputedStyle(window).opacity, inert: window.inert });
    }
    return frames;
  });
  const icon = motionPage.locator('[data-miniapp-id="opencraft.schedules.app"] .overhome__icon');
  const before = await icon.boundingBox();
  const cdp = await motionContext.newCDPSession(motionPage);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: before.x + before.width / 2, y: before.y + before.height / 2 }] });
  await motionPage.waitForTimeout(120);
  const held = await icon.boundingBox();
  assert.ok(held.width < before.width * .96 && held.width > before.width * .82, 'held touch visibly compresses the icon');
  await motionPage.screenshot({ path: output + '/press-phone.png' });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const openTrace = trace();
  await motionPage.waitForFunction(() => {
    const width = document.querySelector('[data-application-scene="app"]')?.getBoundingClientRect().width ?? 0;
    return width > 120 && width < 340;
  });
  await motionPage.screenshot({ path: output + '/opening-phone.png' });
  const opening = await openTrace; motionEvidence.opening = opening;
  assert.ok(opening.some(frame => frame.width > 100 && frame.width < 350), 'launch has actual intermediate window geometry');
  assert.ok(Math.abs(opening.at(-1)!.width - 390) < 1, 'launch reaches the live aperture');
  await motionPage.locator('.scheduled-tasks-page').waitFor();
  await motionPage.locator('.application-route-scene__home').tap();
  const closeTrace = trace();
  await motionPage.waitForFunction(() => {
    const width = document.querySelector('[data-application-scene="app"]')?.getBoundingClientRect().width ?? 0;
    return width > 120 && width < 340;
  });
  await motionPage.screenshot({ path: output + '/closing-phone.png' });
  const closing = await closeTrace; motionEvidence.closing = closing;
  assert.ok(closing.some(frame => frame.inert && frame.width > 70 && frame.width < 350), 'outgoing app is inert while returning toward its icon');
  await settleDesktop();
  assert.equal(await motionPage.locator('[data-miniapp-id="opencraft.schedules.app"]').evaluate(element => document.activeElement === element), true, 'return restores launcher focus');
  // Reverse twice before settling, then choose Chat: the last route wins.
  await motionPage.evaluate(() => document.querySelector<HTMLButtonElement>('[data-miniapp-id]')!.click());
  await motionPage.waitForTimeout(70);
  await motionPage.evaluate(() => document.querySelector<HTMLButtonElement>('.application-route-scene__home')!.click());
  await motionPage.waitForTimeout(70);
  await motionPage.evaluate(() => document.querySelector<HTMLButtonElement>('[data-miniapp-id]')!.click());
  await motionPage.waitForTimeout(70);
  await motionPage.evaluate(() => (window as any).proof.chat());
  await motionPage.locator('[data-application-scene="app"]').waitFor({ state: 'detached' });
  assert.equal((await motionPage.evaluate(() => (window as any).proof.route())).applicationRoute.kind, 'conversation');
  if (!hostless) assert.equal(await motionPage.locator('[contenteditable="true"]').first().evaluate(element =>
    element === (window as any).motionEditor && element.textContent === 'Keep my desktop motion draft'), true);
  await motionPage.evaluate(() => (window as any).proof.open()); await settleDesktop();
  await motionPage.locator('.overhome__search-button').tap();
  const search = motionPage.locator('.overhome__search-field input'); await search.fill('no-such-app');
  assert.equal(await motionPage.locator('[data-miniapp-id]').count(), 0);
  await search.fill('定时'); assert.equal(await motionPage.locator('[data-miniapp-id]').count(), 1);
  await motionPage.keyboard.press('Escape'); await search.waitFor({ state: 'detached' });
  assert.equal(await motionPage.locator('.overhome__search-button').evaluate(element => document.activeElement === element), true);
  await motionPage.locator('.overhome__dock-icon--settings').tap();
  assert.equal((await motionPage.evaluate(() => (window as any).proof.route())).applicationRoute.slug, 'appearance');
  await motionPage.evaluate(() => (window as any).proof.open()); await settleDesktop();
  await motionPage.locator('[data-miniapp-id]').tap(); await motionPage.locator('.scheduled-tasks-page').waitFor();
  await motionPage.setViewportSize({ width: 430, height: 932 });
  await motionPage.locator('.application-route-scene__home').tap(); await settleDesktop();
  assert.equal(await motionPage.locator('.overhome').evaluate(element => element.scrollWidth > element.clientWidth), false);
  await motionPage.setViewportSize({ width: 390, height: 844 });
  await motionPage.emulateMedia({ reducedMotion: 'reduce' });
  await motionPage.locator('[data-miniapp-id]').tap(); await motionPage.locator('.scheduled-tasks-page').waitFor();
  const reduced = await trace(); motionEvidence.reduced = reduced;
  assert.ok(reduced.every(frame => Math.abs(frame.width - 390) < 1), 'reduced motion has no zoom frames');
  await motionPage.locator('.application-route-scene__home').tap(); await settleDesktop();
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  await motionPage.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  const transparency = await motionPage.locator('.overhome__dock').evaluate(element => ({
    supported: matchMedia('(prefers-reduced-transparency: reduce)').matches,
    filter: getComputedStyle(element).backdropFilter, background: getComputedStyle(element).backgroundColor }));
  motionEvidence.transparency = transparency;
  if (transparency.supported && transparency.filter !== 'none') motionEvidence.css = await motionPage.evaluate(() => {
    const out: string[] = [];
    const scan = (rules: CSSRuleList) => { for (const rule of Array.from(rules)) { if (rule.cssText.includes('prefers-reduced-transparency')) out.push(rule.cssText); if ('cssRules' in rule) scan((rule as CSSGroupingRule).cssRules); } };
    for (const sheet of Array.from(document.styleSheets)) { try { scan(sheet.cssRules); } catch {} }
    const dock = document.querySelector('.overhome__dock');
    for (const sheet of Array.from(document.styleSheets)) { try { for (const rule of Array.from(sheet.cssRules)) { if (rule instanceof CSSStyleRule && rule.selectorText.includes('overhome') && dock && dock.matches(rule.selectorText)) out.push(rule.cssText); } } catch {} }
    out.push('groupMatches=' + matchMedia('(prefers-reduced-transparency: reduce), (forced-colors: active)').matches);
    return out;
  });
  if (transparency.supported) { await motionPage.waitForFunction(() => getComputedStyle(document.querySelector('.overhome__dock')!).backdropFilter === 'none', undefined, { timeout: 3000 }); assert.equal(await motionPage.locator('.overhome__dock').evaluate(element => getComputedStyle(element).backdropFilter), 'none'); assert.ok((await motionPage.locator('.overhome__dock').evaluate(element => getComputedStyle(element).backgroundColor)).startsWith('rgb('), 'opaque fallback is not translucent'); }
  await motionPage.screenshot({ path: output + '/reduced-transparency-phone.png' });
  await motionPage.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await motionPage.screenshot({ path: output + '/forced-colors-phone.png' });
  motionEvidence.opening = opening; motionEvidence.closing = closing; motionEvidence.reduced = reduced;
  motionEvidence.held = { before, held }; motionEvidence.transparency = transparency;
  await motionContext.close();
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await writeFile(output + "/browser.json", JSON.stringify({ observed, motionEvidence, errors, external, hostless, boundary: "Real App/Shell/router/desktop/schedules; synthetic product and optional disconnected fixture Host, no employee login or device claims" }, null, 2));
  console.log(motionOnly ? "PASS Overhome motion: held touch, icon-to-window spring, inert return, interrupted routes, draft continuity, search and accessibility fallbacks" : "PASS Overhome: real App desktop/mobile entrances, schedules/history, 8 theme/size/touch combinations, keyboard, long labels, plugin retirement and full motion/accessibility checks");
} catch (error) {
  await mkdir(output, { recursive: true });
  await writeFile(output + "/failure.json", JSON.stringify({ error: String(error), errors, motionEvidence }, null, 2));
  await lastPage?.screenshot({ path: output + "/failure.png" }).catch(() => {});
  throw error;
} finally { await browser?.close(); await vite.close(); }
