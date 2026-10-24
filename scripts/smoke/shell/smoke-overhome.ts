import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const hostless = process.argv.includes("--hostless");
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
  define: { "process.env.NEXT_PUBLIC_REGION": '"cn"', "process.env.NEXT_PUBLIC_PREVIEW_LOCALES": '""',
    "import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN": '"false"', "import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN": '"false"' },
  esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "overhome-smoke", resolveId: id => id === "/proof.tsx" ? id : null, load: id => id === "/proof.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((request, response, next) => {
      if (request.url !== "/") return next(); response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="app"></div><script type="module" src="/proof.tsx"></script>');
    }); } }],
});
let browser: any;
const errors: string[] = [], external: string[] = [], observed: unknown[] = [];
try {
  await vite.listen(); const url = vite.resolvedUrls!.local[0]!, origin = new URL(url).origin;
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true });
  page.setDefaultTimeout(20000); page.on("pageerror", (error: Error) => { errors.push(error.message); console.error(error.message); });
  await page.addInitScript("window.__name = target => target");
  await page.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : (external.push(route.request().url()), route.abort()));
  await page.goto(url); await page.locator('body[data-ready="true"]').waitFor({ timeout: 60000 });
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
    const mobile = page.locator('[data-action-id="shell.applications.header"]:visible');
    if (!hostless && page.viewportSize().width <= 640) await mobile.tap();
    else if (hostless) await page.locator('.shell-navigation__entrance[data-surface="applications"]:visible').first().click();
    else await page.locator('[data-action-id="shell.applications"]:visible').click();
  };
  await launch();
  await page.locator(".overhome").waitFor();
  assert.equal(await page.locator("[data-miniapp-id]").count(), 1);
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
    const geometry = await tile.evaluate((button: HTMLElement) => {
      const r = button.getBoundingClientRect(), root = document.querySelector(".overhome")!;
      return { width: r.width, height: r.height, x: r.x, right: r.right, overflow: root.scrollWidth > root.clientWidth };
    });
    assert.ok(geometry.width >= 44 && geometry.height >= 44 && geometry.x >= 0 && geometry.right <= width && !geometry.overflow);
    observed.push({ appearance, theme, width, geometry });
    await page.screenshot({ path: `${output}/${appearance}-${theme}-${width}.png` });
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
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await writeFile(output + "/browser.json", JSON.stringify({ observed, errors, external, hostless, boundary: "Real App/Shell/router/desktop/schedules; synthetic product and optional disconnected fixture Host, no employee login or device claims" }, null, 2));
  console.log("PASS Overhome: real App desktop/mobile entrances, schedule launch/history, 8 theme/size/touch combinations, keyboard, long labels and plugin retirement");
} finally { await browser?.close(); await vite.close(); }
