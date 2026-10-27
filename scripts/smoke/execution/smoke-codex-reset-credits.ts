import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";

const { chromium } = await import("playwright");
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/opencraft-reset-credit-smoke";
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
let accounts=[2,0,null].map((count,index)=>({id:String(index),label:['two@example.test','zero@example.test','unknown@example.test'][index],priority:index,enabled:true,credentialConfigured:true,email:['two@example.test','zero@example.test','unknown@example.test'][index],subscriptionType:'pro',rateLimitTier:null,status:'ready',observedAt:now,heldUntil:null,lastUsedAt:null,lastUsedHostId:null,limitWindows:[{slot:'primary',windowMinutes:300,utilization:.25,resetAt:now+3600000,observedAt:now},{slot:'secondary',windowMinutes:10080,utilization:.7,resetAt:now+86400000,observedAt:now}],resetCredits:count===null?null:{availableCount:count,observedAt:now}}));
window.calls=[]; window.failRefresh=false;
const service=new CodexAccountsService(async (_host,method,params)=>{
  window.calls.push(method);
  if(method==='opencraft/codex/accounts/refresh'){
    if(window.failRefresh) throw new Error('合成刷新失败：two@example.test');
    accounts=accounts.map(a=>a.id===params.accountId?{...a,resetCredits:{availableCount:4,observedAt:Date.now()}}:a);
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
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value;");
    await page.goto(url);
    await page.locator(".engine-account__reset-credits strong").first().waitFor();
    assert.deepEqual(await page.locator(".engine-account__reset-credits strong").allTextContents(), ["2 张", "0 张", "—"]);
    await page.locator(".engine-account__disclosure").first().click();
    await page.getByText("重置券最近确认", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.locator(".engine-account__reset-credits").evaluateAll(elements => elements.every(element => {
      const slot = element.getBoundingClientRect();
      const row = element.closest(".engine-account__row")!.getBoundingClientRect();
      return slot.left >= row.left && slot.right <= row.right && slot.right <= innerWidth;
    })), true, "every account's reset count stays inside its row");
    for (const address of ["two@example.test", "zero@example.test", "unknown@example.test"]) assert.equal((await page.locator("body").innerHTML()).includes(address), false, "default DOM and accessible labels must mask email");
    assert.equal(await page.locator(".engine-account__details dd").first().textContent(), "***wo@e***.test");
    await page.getByRole("button", { name: "***wo@e***.test 的操作" }).click();
    await page.getByRole("menuitem", { name: "移除账户" }).click();
    const confirmation = page.getByRole("alertdialog");
    await confirmation.waitFor();
    assert.match(await confirmation.innerText(), /\*\*\*wo@e\*\*\*\.test/);
    assert.equal((await confirmation.innerHTML()).includes("two@example.test"), false);
    await confirmation.getByRole("button", { name: "取消", exact: true }).click();
    await confirmation.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.body.style.pointerEvents !== "none");
    await page.screenshot({ path: join(output, `${theme}-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "***wo@e***.test 的操作" }).click();
    await page.getByRole("menuitem", { name: "刷新用量" }).click();
    await page.waitForFunction(() => document.querySelector(".engine-account__reset-credits strong")?.textContent === "4 张");
    await page.locator('[role="menu"]').waitFor({ state: "detached" });
    await page.evaluate(() => { (window as any).failRefresh = true; });
    await page.getByRole("button", { name: "***wo@e***.test 的操作" }).click();
    await page.getByRole("menuitem", { name: "刷新用量" }).click();
    await page.getByRole("alert").getByText("合成刷新失败：***wo@e***.test", { exact: true }).first().waitFor();
    assert.equal(await page.locator(".engine-account__reset-credits strong").first().textContent(), "4 张");
    assert.equal((await page.locator("body").innerHTML()).includes("two@example.test"), false);
    const calls = await page.evaluate(() => (window as any).calls as string[]);
    assert.deepEqual(calls, ["opencraft/codex/accounts/list", "opencraft/codex/accounts/refresh", "opencraft/codex/accounts/refresh"]);
    assert.deepEqual(errors, []);
    results.push({ width, theme, counts: [2, 0, null], refreshed: 4, failedRefreshRetained: true, calls, overflow: false, errors });
    await page.close();
  }
  await writeFile(join(output, "result.json"), JSON.stringify(results, null, 2));
  console.log("Codex account email masking (row/details/actions/confirmation/errors) and reset counts: 2/0/unknown, refresh, failure retention, desktop/mobile and light/dark passed");
} finally { await browser?.close(); await vite.close(); }
