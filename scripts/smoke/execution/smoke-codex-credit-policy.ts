import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";

const { chromium } = await import("playwright");
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/opencraft-credit-policy-smoke";
await mkdir(output, { recursive: true });
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {createCodexAccountsView} from '/plugins/builtin-agents/src/codex-accounts/view.tsx';
import {CodexAccountsService} from '/plugins/builtin-agents/src/codex-accounts/service.ts';
import {buildOpenCraftThemeCssProperties,opencraftNeutralThemePalette} from '/packages/design-system/src/theme-engine.ts';
import '/apps/workbench-web/src/styles/app.scss';
import '/apps/workbench-web/src/styles/settings-panel.scss';
import '/apps/workbench-web/src/styles/engine-accounts.scss';
const mode=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';
document.documentElement.dataset.theme=mode;
for(const [key,value] of Object.entries(buildOpenCraftThemeCssProperties(mode,opencraftNeutralThemePalette[mode]))) document.documentElement.style.setProperty(key,value);
const now=Date.now();
let accounts=[2,0,null].map((count,index)=>({id:String(index),label:['two@example.test','zero@example.test','unknown@example.test'][index],priority:index,enabled:true,...(index<2?{allowCredits:index===1}:{}),credentialConfigured:true,email:['two@example.test','zero@example.test','unknown@example.test'][index],subscriptionType:'pro',rateLimitTier:null,status:'ready',observedAt:now,heldUntil:null,lastUsedAt:null,lastUsedHostId:null,limitWindows:[{slot:'primary',windowMinutes:300,utilization:.25,resetAt:now+3600000,observedAt:now},{slot:'secondary',windowMinutes:10080,utilization:.7,resetAt:now+86400000,observedAt:now}],resetCredits:count===null?null:{availableCount:count,observedAt:now}}));
window.calls=[]; window.failRefresh=false; window.failCredits=false;
const service=new CodexAccountsService(async (_host,method,params)=>{
  window.calls.push(method);
  if(method==='opencraft/codex/accounts/refresh'){
    if(window.failRefresh) throw new Error('合成刷新失败：two@example.test');
    accounts=accounts.map(a=>a.id===params.accountId?{...a,resetCredits:{availableCount:4,observedAt:Date.now()}}:a);
  }else if(method==='opencraft/codex/accounts/setAllowCredits'){
    await new Promise(resolve=>setTimeout(resolve,200));
    if(window.failCredits) throw new Error('合成积分设置失败');
    accounts=accounts.map(a=>a.id===params.accountId?{...a,allowCredits:params.allowCredits}:a);
  }else if(method!=='opencraft/codex/accounts/list') throw new Error('Unexpected mutation: '+method);
  return {accounts};
},'fixture');
const View=createCodexAccountsView(service,{allowImport:false});
createRoot(document.getElementById('root')).render(<View/>);
`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "codex-reset-credit-fixture", resolveId: id => id === "/reset-probe.tsx" ? id : null,
    load: id => id === "/reset-probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((request, response, next) => {
      if (request.url !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:var(--color-background-primary);color:var(--color-text)}#root{container:settings-panel/inline-size;min-height:100vh;padding:16px;box-sizing:border-box}</style><div id="root"></div><script type="module" src="/reset-probe.tsx"></script></html>');
    }); },
  }],
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const results: unknown[] = [];
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const url = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width === 390, colorScheme: theme });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value;");
    await page.goto(url);
    page.setDefaultTimeout(15000);
    await page.locator(".engine-account__reset-credits strong").first().waitFor();
    assert.deepEqual(await page.locator(".engine-account__reset-credits strong").allTextContents(), ["2 张", "0 张", "—"]);
    await page.locator(".engine-account__disclosure").first().click();
    await page.getByText("重置券最近确认", { exact: true }).waitFor();
    const creditSwitch = page.getByRole("switch", { name: "允许使用积分", exact: true });
    await creditSwitch.waitFor();
    assert.equal(await creditSwitch.getAttribute("aria-checked"), "false");
    if (width === 390) await creditSwitch.tap(); else { await creditSwitch.focus(); await creditSwitch.press("Space"); }
    await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'true');
    await page.evaluate(() => { (window as any).failCredits = true; });
    if (width === 390) await creditSwitch.tap(); else await creditSwitch.click();
    await page.getByRole("alert").getByText("合成积分设置失败", {exact:true}).waitFor();
    assert.equal(await creditSwitch.getAttribute("aria-checked"), "true", "failed save retains the committed value");
    await page.evaluate(() => { (window as any).failCredits = false; });
    await creditSwitch.click();
    await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'false');
    await page.locator(".engine-account__disclosure").first().click();
    await page.locator(".engine-account__disclosure").nth(2).click();
    assert.equal(await creditSwitch.isDisabled(), true, "old Hosts cannot edit unsupported policy");
    await page.getByText("当前服务端不支持设置积分使用策略。",{exact:true}).waitFor();
    await page.locator(".engine-account__disclosure").nth(2).click();
    await page.locator(".engine-account__disclosure").first().click();
    assert.equal(await creditSwitch.getAttribute("aria-checked"), "false");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.locator(".engine-account__reset-credits").evaluateAll(elements => elements.every(element => {
      const slot = element.getBoundingClientRect();
      const row = element.closest(".engine-account__row")!.getBoundingClientRect();
      return slot.left >= row.left && slot.right <= row.right && slot.right <= innerWidth;
    })), true, "every account's reset count stays inside its row");
    for (const address of ["two@example.test", "zero@example.test", "unknown@example.test"]) assert.equal((await page.locator("body").innerHTML()).includes(address), false, "default DOM and accessible labels must mask email");
    assert.equal(await page.locator(".engine-account__details dd").first().textContent(), "***wo@e***.test");
    const copyWidth = await page.locator('.engine-account__credit-policy .settings-control-row__copy').evaluate(el => el.getBoundingClientRect().width);
    assert.ok(copyWidth > width * (width === 390 ? .4 : .2), "preference copy has readable width");
    await page.screenshot({ path: join(output, `${theme}-${width}.png`), fullPage: true });
    const calls = await page.evaluate(() => (window as any).calls as string[]);
    assert.deepEqual(calls, ["opencraft/codex/accounts/list", ...Array(3).fill("opencraft/codex/accounts/setAllowCredits")]);
    assert.deepEqual(errors, []);
    results.push({ width, theme, creditPolicy: "off/on/failed-off/off", oldHostDisabled: true, keyboard: width !== 390, touch: width === 390, calls, overflow: false, errors });
    await page.close();
  }
  await writeFile(join(output, "result.json"), JSON.stringify(results, null, 2));
  console.log("Codex per-account credit policy: on/off, failed save retention, unsupported Host, keyboard/touch, light/dark, narrow/wide passed");
} finally { await browser?.close(); await vite.close(); }
