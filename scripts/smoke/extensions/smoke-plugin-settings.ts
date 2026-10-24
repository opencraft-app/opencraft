import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
// Real application bootstrap, Settings, Router, Supervisor and Manager. Only
// product composition and the self-contained test plugin use local fixtures.
const withHost = process.argv.includes("--with-host");
const evidenceDirectory = `.local/plugin-settings/${withHost ? "active" : "hostless"}`;
const source = `
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createWebWorkbenchApplication,WorkbenchRoot} from '/apps/workbench-web/src/workbench-root.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import {projectExtensionCatalog} from '/packages/extension-runtime/src/catalog.ts';
import '/apps/workbench-web/src/styles/app.scss';
import {createSmokeClientProduct} from '/tests/fixtures/client-product.ts';
initializeAppearanceTheme();
if (${withHost}) {
  const config=document.createElement('script'); config.id='opencraft-deployment-config'; config.type='application/json';
  config.textContent=JSON.stringify({hosts:[{hostId:'fixture-host',label:'Fixture Host',kind:'remote-ssh',url:location.origin.replace('http','ws')+'/fixture-rpc'}],builtinAgents:false,hypernode:false});
  document.head.append(config);
}
console.log("plugin-proof: bootstrap");
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory',clientProduct:createSmokeClientProduct()});
console.log("plugin-proof: application ready");
const supervisor=application.supervisor;
const manifest={manifestVersion:1,id:'example.failed',name:'Failed fixture',version:'1.2.3',apiVersion:1,trust:'trusted',platforms:['web'],activationEvents:['onStartupFinished']};
console.log('plugin-proof: failed fixture');
await supervisor.extensions.activateOptional({manifest,activate(){throw new Error('Fixture activation failed');}});
console.log('plugin-proof: install fixture');
await supervisor.extensionManager.installModuleUrl(location.origin+'/fixture-plugin.mjs');
await supervisor.extensionManager.setEnabled('example.installed',false);
const nav=supervisor.navigation;
nav.openSettings('appearance');
createIntlTestRoot(document.getElementById('app'),undefined,'zh-CN').render(<WorkbenchRoot application={application}/>);
window.proof={
 route:()=>nav.getSnapshot().applicationRoute,
 open:()=>nav.openSettings('plugins'),
 back:()=>nav.back(),
 catalog:()=>projectExtensionCatalog(supervisor.extensions.getSnapshot(),supervisor.extensionManager.getSnapshot(),supervisor.extensions.contributions.getSnapshot()),
 theme:setThemePreference,
 mode:supervisor.mode,
};
document.body.dataset.ready='true';`;
const plugin = `export default {manifest:{manifestVersion:1,id:'example.installed',name:'Installed fixture',version:'2.3.4',apiVersion:1,trust:'trusted',platforms:['web'],activationEvents:['onStartupFinished']},activate(){}};`;
const server = await createServer({ configFile: false, cacheDir: ".local/plugin-settings/vite-cache", root: process.cwd(), logLevel: "error",
  define: { "process.env.NEXT_PUBLIC_REGION": '"cn"', "process.env.NEXT_PUBLIC_PREVIEW_LOCALES": '""',
    "import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN": '"false"', "import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN": '"false"' },
  esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 0, hmr: false }, plugins: [{
    name: "plugin-settings-proof", resolveId: id => id === "/proof.tsx" ? id : null,
    load: id => id === "/proof.tsx" ? source : null,
    configureServer(vite) { vite.middlewares.use((req, res, next) => {
      if (req.url === "/") {
        res.setHeader("Content-Type", "text/html");
        res.end('<html><body><div id="app"></div><script type="module" src="/proof.tsx"></script></body></html>');
      } else if (req.url?.startsWith("/fixture-plugin.mjs")) {
        res.setHeader("Content-Type", "text/javascript"); res.end(plugin);
      } else next();
    }); },
  }],
});
let browser: any;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript("window.__name = target => target;");
  const externalOrigins: string[] = [];
  const origin = new URL(server.resolvedUrls!.local[0]).origin;
  await page.route("**/*", (route: any) => {
    const requested = new URL(route.request().url());
    if (requested.origin === origin) return route.continue();
    externalOrigins.push(requested.origin); return route.abort();
  });
  const errors: string[] = []; page.on("pageerror", (error: Error) => { errors.push(error.message); console.error("Page error:", error.message); });
  page.on("console", message => { if (message.type() === "error" || message.text().startsWith("plugin-proof:")) console.error("Browser:", message.text().slice(0,600)); });
  await page.goto(server.resolvedUrls!.local[0]);
  await page.waitForSelector('body[data-ready="true"]', { timeout: 60000 });
  const nav = page.getByRole('navigation', { name: 'Settings sections', exact: true });
  await nav.getByRole('button', { name: '插件', exact: true }).click();
  const library = page.getByRole('region', { name: '扩展管理', exact: true });
  await library.getByLabel('搜索扩展').waitFor();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => (window as any).proof.route().slug), 'plugins', 'ordinary route must not be redirected');
  assert.equal(await library.locator('.settings-control-list-item').count(), await page.evaluate(() => (window as any).proof.catalog().length));
  assert.equal(await library.getByText('从 URL 安装可信扩展', { exact: true }).count(), 0);
  await library.getByLabel('搜索扩展').fill('Installed fixture');
  await library.getByText('用户安装 · 2.3.4 · 已停用', { exact: true }).waitFor();
  await library.getByRole('switch', { name: '启用 Installed fixture' }).waitFor();
  await library.getByLabel('搜索扩展').fill('Failed fixture');
  await library.getByText('Fixture activation failed', { exact: true }).waitFor();
  assert.equal(await library.getByRole('switch').count(), 0, 'unmanaged built-ins stay protected');
  await library.getByLabel('搜索扩展').fill('Optional fixture');
  await library.getByRole('switch', { name: '启用 Optional fixture' }).click();
  await library.getByRole('switch', { name: '停用 Optional fixture' }).waitFor();
  await library.getByRole('switch', { name: '停用 Optional fixture' }).click();
  await library.getByRole('switch', { name: '启用 Optional fixture' }).waitFor();
  await library.getByLabel('搜索扩展').fill('does-not-exist');
  await library.getByText('没有匹配的扩展。', { exact: true }).waitFor();
  await library.getByLabel('搜索扩展').fill('');
  await mkdir(evidenceDirectory, { recursive: true });
  for (const theme of ['light','dark']) {
    await page.evaluate(theme => (window as any).proof.theme(theme), theme);
    for (const width of [1440,390]) {
      await page.setViewportSize({ width, height: 1000 });
      const toggle = page.locator('[data-chrome-action-id="sidebar-toggle"]:visible').first();
      if ((await toggle.getAttribute('aria-expanded') === 'true') !== (width > 600)) await toggle.click();
      // Leave the toggle's hover/focus zone and dismiss the floating index,
      // as a user does before reading the narrow content surface.
      if (width <= 600) await page.keyboard.press("Escape");
      await page.mouse.click(width - 8, 100);
      await page.mouse.move(width - 8, 120);
      await page.waitForTimeout(400);
      await page.screenshot({ path: evidenceDirectory+'/'+theme+'-'+width+'.png', fullPage: true });
      const box = await library.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1 && (width > 600 || box.width > 300), 'plugin list stays inside viewport');
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => (window as any).proof.back());
  await page.waitForFunction(() => (window as any).proof.route().slug === 'appearance');
  await page.evaluate(() => (window as any).proof.open());
  await library.getByLabel('搜索扩展').waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(externalOrigins, [], "the probe must not depend on external product services");
  const evidence = await page.evaluate(() => ({
    mode: (window as any).proof.mode,
    route: (window as any).proof.route(),
    plugins: (window as any).proof.catalog().map(({id,version,status,source}: any) => ({id,version,status,source})),
  }));
  assert.equal(evidence.mode, withHost ? 'active' : 'hostless');
  await writeFile(evidenceDirectory+'/browser.json', JSON.stringify(evidence,null,2));
  console.log('PASS: ordinary Settings navigation, deep-link/back, complete catalog, disabled/failed states, optional enable/disable, protected built-ins, developer-only install, search, light/dark and narrow viewport.');
} finally { await browser?.close(); await server.close(); }
