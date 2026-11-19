import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
const { chromium } = await import("playwright");
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/opencraft-account-diagnostics";
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
const failure={code:'renewal-incomplete',stage:'renewal',retryable:true,occurredAt:Date.now(),diagnosticId:'11111111-2222-4333-8444-555555555555'};
let account={id:'a',label:'person@example.test',priority:0,enabled:true,credentialConfigured:true,credentialSource:'managed',email:null,subscriptionType:'pro',rateLimitTier:null,status:'ready',observedAt:null,heldUntil:null,lastUsedAt:null,lastUsedHostId:null,limitWindows:[],maintenance:{state:'ok',checkedAt:1,lastSuccessAt:1}};
window.calls=[];
const service=new CodexAccountsService(async(_host,method,params)=>{
 window.calls.push({method,params});
 if(method.endsWith('/refresh')){account={...account,maintenance:{state:'error',checkedAt:failure.occurredAt,lastSuccessAt:1,failure}};throw Object.assign(new Error('private-provider-body Bearer synthetic-secret'),{data:{codexAccountFailure:failure}});}
 if(method.endsWith('/setEnabled'))throw Object.assign(new Error('private-provider-body'),{data:{codexAccountFailure:{...failure,stage:'operation',code:'operation-failed',diagnosticId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'}}});
 return {accounts:[account]};
},'synthetic-host');
window.recover=async()=>{account={...account,status:'ready',maintenance:{state:'ok',checkedAt:Date.now()+1,lastSuccessAt:Date.now()+1}};await service.refresh();};
window.legacy=async()=>{account={...account,maintenance:undefined};await service.refresh();};
const View=createCodexAccountsView(service);
createRoot(document.getElementById('root')).render(<IntlRuntimeProvider runtime={locale}><View/></IntlRuntimeProvider>);
`;
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] },
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "account-diagnostic-fixture",
      resolveId: (id) => (id === "/reference.tsx" ? id : null),
      load: (id) => (id === "/reference.tsx" ? source : null),
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== "/") return next();
          response.setHeader("content-type", "text/html");
          response.end(
            '<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:var(--color-background-surface);color:var(--color-text)}#root{container:settings-panel/inline-size;min-height:100vh;padding:16px;box-sizing:border-box}</style><div id="root"></div><script type="module" src="/reference.tsx"></script></html>',
          );
        });
      },
    },
  ],
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  for (const width of [390, 1000])
    for (const colorScheme of ["light", "dark"] as const) {
      const touch = width === 390;
      const page = await browser.newPage({
        viewport: { width, height: 1000 },
        colorScheme,
        hasTouch: touch,
        isMobile: touch,
      });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(vite.resolvedUrls!.local[0]!);
      const row = page.locator(".engine-account");
      await row.locator(".engine-account__status-copy").filter({ hasText: /^可用/ }).waitFor();
      const openMenu = async () => {
        const trigger = row.getByRole("button", { name: /的操作/ });
        if (touch) await trigger.tap();
        else {
          await trigger.focus();
          await page.keyboard.press("Enter");
        }
      };
      const choose = async (name: string) => {
        const item = page.getByRole("menuitem", { name, exact: true });
        if (touch) await item.tap();
        else {
          await item.focus();
          await page.keyboard.press("Enter");
        }
      };
      await openMenu();
      await choose("刷新用量");
      await row.getByText("续期未返回有效凭据，账号尚未恢复。", { exact: true }).waitFor();
      assert.equal(await row.getAttribute("data-status"), "held");
      assert.equal(await row.getByText("认证异常", { exact: true }).count(), 0);
      assert.equal(await row.locator(".engine-account__status-copy").filter({ hasText: /^可用/ }).count(), 0);
      assert.equal(await row.getByText("renewal-incomplete", { exact: true }).count(), 1);
      assert.equal(await page.getByText(/private-provider-body|synthetic-secret/).count(), 0);
      const copy = row.getByRole("button", { name: "复制诊断编号", exact: true });
      if (touch) {
        assert.ok((await copy.boundingBox())!.height >= 44);
        await copy.tap();
      } else await copy.click();
      await row.getByText("诊断编号已复制", { exact: true }).waitFor();
      await page.locator(".engine-account-menu").waitFor({ state: "detached" });
      await page.screenshot({ path: join(output, `${width}-${colorScheme}-renewal.png`), fullPage: true });
      await page.evaluate(() => (window as any).recover());
      await row.locator(".engine-account__status-copy").filter({ hasText: /^可用/ }).waitFor();
      assert.equal(
        await row.locator(".engine-account__action-error,.engine-account__diagnostic").count(),
        0,
        "confirmed recovery resolves only refresh feedback",
      );
      await openMenu();
      await choose("停用账户");
      await row.getByText("上次操作未完成；账号可用不代表该操作已成功。", { exact: true }).waitFor();
      await page.evaluate(() => (window as any).recover());
      assert.equal(
        await row.locator(".engine-account__action-error").count(),
        1,
        "a state read must not hide a failed mutation",
      );
      await page.evaluate(() => (window as any).legacy());
      assert.equal(
        await row.locator(".engine-account__action-error").count(),
        1,
        "older Host absence is not evidence of success",
      );
      await row.getByRole("button", { name: "关闭提示", exact: true }).click();
      assert.equal(await row.locator(".engine-account__action-error").count(), 0);
      const calls = await page.evaluate(() => (window as any).calls);
      assert.equal(calls.filter((c: any) => c.method.endsWith("/refresh")).length, 1);
      assert.equal(calls.filter((c: any) => c.method.endsWith("/setEnabled")).length, 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      await page.close();
    }
  console.log(
    "Actual account Settings: safe renewal diagnostics, copied correlation ID, false-green prevention, recovered refresh feedback, retained mutation failure, old Host fallback; phone touch/desktop keyboard, light/dark passed (synthetic Host).",
  );
} finally {
  await browser?.close();
  await vite.close();
}
