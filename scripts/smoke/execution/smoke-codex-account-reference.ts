import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
const { chromium } = await import("playwright");
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/opencraft-account-reference";
await mkdir(output, { recursive: true });
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {LocaleRuntime} from '/packages/i18n/src/index.ts';
import {IntlRuntimeProvider} from '/packages/i18n/src/react.tsx';
import zh from '/apps/workbench-web/src/i18n/locales/zh-CN.json';
import {createCodexAccountsView} from '/plugins/builtin-agents/src/codex-accounts/view.tsx';
import {CodexAccountsService} from '/plugins/builtin-agents/src/codex-accounts/service.ts';
import {buildOpenCraftThemeCssProperties,opencraftNeutralThemePalette} from '/packages/design-system/src/theme-engine.ts';
import '/apps/workbench-web/src/styles/app.scss';
import '/apps/workbench-web/src/styles/settings-panel.scss';
import '/apps/workbench-web/src/styles/engine-accounts.scss';
const mode=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';
document.documentElement.dataset.theme=mode;
if(navigator.maxTouchPoints) document.documentElement.dataset.touchInteraction='';
for(const [k,v] of Object.entries(buildOpenCraftThemeCssProperties(mode,opencraftNeutralThemePalette[mode])))document.documentElement.style.setProperty(k,v);
const locale=new LocaleRuntime([{locale:'zh-CN',label:'中文',load:async()=>zh}]);
await locale.update({enabled:true,localeOverride:'zh-CN'});window.locale=locale;
let accounts=['external-file','managed'].map((credentialSource,index)=>({id:String(index),label:'person@example.test',priority:index,enabled:true,credentialConfigured:true,credentialSource,email:null,subscriptionType:'pro',rateLimitTier:null,status:index===0?'error':'ready',observedAt:null,heldUntil:null,lastUsedAt:null,lastUsedHostId:null,limitWindows:[]}));
window.calls=[];
const service=new CodexAccountsService(async(_host,method,params)=>{
 window.calls.push({method,params});
 if(method.endsWith('/import'))throw new Error('synthetic diagnostic must stay hidden');
 if(method.endsWith('/remove'))accounts=accounts.filter(a=>a.id!==params.accountId);
 return {accounts};
},'synthetic-host');
const View=createCodexAccountsView(service);
createRoot(document.getElementById('root')).render(<IntlRuntimeProvider runtime={locale}><View/></IntlRuntimeProvider>);
`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", resolve: { dedupe: ["react", "react-dom"] }, esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, hmr: false }, plugins: [{ name: "account-reference-fixture", resolveId: id => id === "/reference.tsx" ? id : null,
    load: id => id === "/reference.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((request, response, next) => {
      if (request.url !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:var(--color-background-surface);color:var(--color-text)}#root{container:settings-panel/inline-size;min-height:100vh;padding:16px;box-sizing:border-box}</style><div id="root"></div><script type="module" src="/reference.tsx"></script></html>');
    }); },
  }],
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const width of [390, 1000]) for (const colorScheme of ["light", "dark"] as const) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme, hasTouch: width === 390, isMobile: width === 390 });
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(vite.resolvedUrls!.local[0]!);
    await page.getByText('本机 Codex 登录（只读）', { exact: true }).waitFor().catch(async error => { console.error(errors, await page.locator('body').innerText()); throw error; });
    assert.ok(await page.getByText('账号池凭据（设备码或旧副本）', { exact: true }).isVisible());
    assert.ok(await page.getByRole('alert').filter({ hasText: 'codex login' }).isVisible());
    await page.getByRole('button', { name: '添加账户', exact: true }).click();
    await page.getByRole('menuitem', { name: /使用本机 Codex 登录/ }).click();
    await page.getByText(/无法使用本机 Codex 登录/).waitFor();
    await page.getByRole('menu').waitFor({ state: 'hidden' });
    assert.equal(await page.getByText(/synthetic diagnostic/).count(), 0);
    assert.deepEqual(await page.evaluate(() => (window as any).calls.find((c: any) => c.method.endsWith('/import')).params), {});
    await page.screenshot({ path: join(output, `${width}-${colorScheme}.png`), fullPage: true });
    const actions = page.locator('.engine-account').first().getByRole('button', { name: /的操作/ });
    await actions.click(); await page.getByRole('menuitem', { name: '移除账户' }).click();
    await page.getByText('仅移除此账户在账号池中的引用。本机 Codex 登录和会话记录会保留。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('.engine-account__disclosure').first().click();
    const focused = page.getByRole('button', { name: '添加账户', exact: true });
    await focused.focus();
    await page.evaluate(() => (window as any).locale.update({ enabled: true, localeOverride: 'en-US' }));
    await page.getByText('Local Codex login (read-only)', { exact: true }).waitFor();
    assert.equal(await focused.evaluate(el => document.activeElement === el), true);
    assert.equal(await page.locator('.engine-account__disclosure').first().getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Account reference settings: sources, renewal, import failure, removal, locale continuity, narrow/wide and light/dark passed (synthetic Host).');
} finally { await browser?.close(); await vite.close(); }
