import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import type { Locator } from "playwright";
const { chromium } = await import("playwright");
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/opencraft-reset-redemption";
await mkdir(output, { recursive: true });
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {LocaleRuntime} from '/packages/i18n/src/index.ts';
import {IntlRuntimeProvider} from '/packages/i18n/src/react.tsx';
import {createCodexAccountsView} from '/plugins/builtin-agents/src/codex-accounts/view.tsx';
import {CodexAccountsService} from '/plugins/builtin-agents/src/codex-accounts/service.ts';
import {buildOpenCraftThemeCssProperties,opencraftNeutralThemePalette} from '/packages/design-system/src/theme-engine.ts';
import zh from '/apps/workbench-web/src/i18n/locales/zh-CN.json';
import '/apps/workbench-web/src/styles/app.scss';
import '/apps/workbench-web/src/styles/settings-panel.scss';
import '/apps/workbench-web/src/styles/engine-accounts.scss';
const mode=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';
document.documentElement.dataset.theme=mode;
for(const [k,v] of Object.entries(buildOpenCraftThemeCssProperties(mode,opencraftNeutralThemePalette[mode])))document.documentElement.style.setProperty(k,v);
const locale=new LocaleRuntime([{locale:'zh-CN',label:'中文',load:async()=>zh}]);
await locale.update({enabled:true,localeOverride:'zh-CN'});
window.locale=locale;
const now=Date.now();
const legacy=new URL(location.href).searchParams.has('legacy');
const account={id:'synthetic-a',label:'person@example.test',priority:1,enabled:true,credentialConfigured:true,email:'person@example.test',subscriptionType:'pro',rateLimitTier:null,status:'ready',observedAt:now,heldUntil:null,lastUsedAt:null,lastUsedHostId:null,limitWindows:[],resetCreditActions:!legacy,resetCredits:{availableCount:2,observedAt:now}};
let coupons=[{id:'synthetic-credit-available',title:null,status:'available',resetType:'codex_rate_limits',supportedByPlan:true,grantedAt:now-10000,expiresAt:now+86400000,expiryKnown:true},{id:'synthetic-credit-expired',title:null,status:'available',resetType:'codex_rate_limits',supportedByPlan:true,grantedAt:now-20000,expiresAt:now-1000,expiryKnown:true},{id:'synthetic-credit-unknown-expiry',title:null,status:'available',resetType:'codex_rate_limits',supportedByPlan:true,grantedAt:now-10000,expiresAt:null,expiryKnown:false}];
window.calls=[];window.notices=[];window.mode='unknown';window.held=false;
const details=()=>({availableCount:2,observedAt:Date.now(),credits:coupons});
const service=new CodexAccountsService(async(_host,method,params)=>{
  window.calls.push({method,params});
  if(method==='opencraft/codex/accounts/list')return {accounts:[account]};
  if(method==='opencraft/codex/accounts/resetCredits/list')return details();
  if(method==='opencraft/codex/accounts/resetCredits/consume'){
    if(window.held)await new Promise(resolve=>window.releaseUse=resolve);
    if(window.mode==='throw')throw new Error('synthetic lost reply');
    if(window.mode==='reset')coupons=coupons.map(c=>c.id===params.creditId?{...c,status:'redeemed'}:c);
    return {outcome:window.mode,credits:details(),usageRefreshed:true,accounts:[account]};
  }
  throw new Error('Unexpected synthetic RPC '+method);
},'synthetic-host');
const View=createCodexAccountsView(service,{allowImport:false});
createRoot(document.getElementById('root')).render(<IntlRuntimeProvider runtime={locale}><View reportError={n=>window.notices.push(n)}/></IntlRuntimeProvider>);
`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", resolve: { dedupe: ["react", "react-dom"] }, esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, hmr: false }, plugins: [{ name: "synthetic-reset-redemption", resolveId: id => id === "/reset-redemption.tsx" ? id : null,
    load: id => id === "/reset-redemption.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((request, response, next) => {
      if (new URL(request.url ?? "/", "http://localhost").pathname !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:var(--color-background-surface);color:var(--color-text)}#root{container:settings-panel/inline-size;min-height:100vh;padding:16px;box-sizing:border-box}</style><div id="root"></div><script type="module" src="/reset-redemption.tsx"></script></html>');
    }); },
  }] });
const results: unknown[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const url = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  for (const width of [1280, 390]) for (const theme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, hasTouch: width === 390 });
    // This acceptance fixture cannot reach any real external endpoint.
    await context.route(/^https:\/\//u, route => route.abort());
    const page = await context.newPage();
    const press = (locator: Locator) => width === 390 ? locator.tap() : locator.click();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value;");
    page.setDefaultTimeout(15_000);
    await page.goto(url);
    await press(page.locator(".engine-account__disclosure"));
    const panel = page.locator(".engine-reset-credits");
    await press(panel.getByRole("button", { name: "查看重置券", exact: true }));
    const use = panel.getByRole("button", { name: "使用重置券", exact: true });
    await use.first().waitFor();
    assert.equal(await use.count(), 3);
    assert.equal(await use.nth(1).isDisabled(), true);
    assert.equal(await use.nth(2).isDisabled(), true);
    assert.equal(await page.evaluate(() => (window as any).calls.some((c: any) => c.method.endsWith("/consume"))), false);
    await press(use.first());
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /synthetic-credit-available/u);
    assert.doesNotMatch(await dialog.innerText(), /person@example\.test/u);
    await page.evaluate(() => (window as any).locale.update({ localeOverride: "en-US" }));
    await dialog.getByText("Use this reset credit?", { exact: true }).waitFor();
    assert.match(await dialog.innerText(), /synthetic-credit-available/u);
    await page.evaluate(() => (window as any).locale.update({ localeOverride: "zh-CN" }));
    await dialog.getByText("使用这张重置券？", { exact: true }).waitFor();
    await page.screenshot({ path: join(output, `${theme}-${width}-confirm.png`), fullPage: true });
    await press(dialog.getByRole("button", { name: "取消", exact: true }));
    await dialog.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => (window as any).calls.some((c: any) => c.method.endsWith("/consume"))), false);
    await press(use.first());
    await press(dialog.getByRole("button", { name: "使用重置券", exact: true }));
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => (window as any).notices.length === 1);
    assert.equal(await use.first().isDisabled(), true, "unknown result requires refresh");
    await press(panel.getByRole("button", { name: "刷新", exact: true }));
    await use.first().waitFor({ state: "visible" });
    await page.waitForFunction(() => !(document.querySelector('.engine-reset-credits .settings-control-button:last-child') as HTMLButtonElement)?.disabled);
    await page.evaluate(() => { (window as any).held = true; (window as any).mode = "reset"; });
    await press(use.first());
    await press(dialog.getByRole("button", { name: "使用重置券", exact: true }));
    await page.waitForFunction(() => typeof (window as any).releaseUse === "function");
    assert.equal(await dialog.getByRole("button", { name: "正在使用…", exact: true }).isDisabled(), true);
    await page.screenshot({ path: join(output, `${theme}-${width}-pending.png`), fullPage: true });
    await page.evaluate(() => (window as any).releaseUse());
    await dialog.waitFor({ state: "detached" });
    await panel.getByText("Codex 额度已重置。", { exact: true }).waitFor();
    const calls = await page.evaluate(() => (window as any).calls);
    const attempts = calls.filter((c: any) => c.method.endsWith("/consume"));
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].params.creditId, "synthetic-credit-available");
    assert.equal(attempts[0].params.idempotencyKey, attempts[1].params.idempotencyKey);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(output, `${theme}-${width}-details.png`), fullPage: true });
    await page.goto(url + '/?legacy=1');
    await press(page.locator(".engine-account__disclosure"));
    assert.equal(await page.locator(".engine-reset-credits").count(), 0, "old Hosts have no unsupported actions");
    assert.deepEqual(errors, []);
    results.push({ width, theme, hasTouch: width === 390, cancelSentNothing: true, unknownRequiredRefresh: true, sameRetryKey: true, pendingLocked: true, oldHostCompatible: true, externalResets: 0, errors });
    await context.close();
  }
  await writeFile(join(output, "result.json"), JSON.stringify(results, null, 2));
  console.log("Reset-credit account Settings: four desktop/touch light/dark scenarios passed; synthetic RPC only, no external resets.");
} finally { await browser?.close(); await vite.close(); }
