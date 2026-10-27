import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { CodexAccountService } from "../../../packages/account-pool-host/src/codex-account-service.js";
import type { CodexMaintenanceClient } from "../../../packages/account-pool-host/src/codex-auth.js";

const { chromium } = await import("playwright");
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/opencraft-device-login-smoke";
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "opencraft-mobile-auth-"));
let owner: CodexAccountService | undefined;
let complete: (() => Promise<void>) | undefined;
let pollRequests = 0;
let usageRequests = 0;
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
const service=new CodexAccountsService(async (_host,method,params)=>{
  const response=await fetch('/fixture/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,params})});
  if(!response.ok)throw new Error('Fixture request failed');
  return response.json();
},'fixture');
const View=createCodexAccountsView(service,{allowImport:false});
createRoot(document.getElementById('root')).render(<View/>);
`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "engine-device-login-fixture", resolveId: id => id === "/device-probe.tsx" ? id : null,
    load: id => id === "/device-probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((request, response, next) => {
      if (request.url === "/fixture/rpc") {
        void (async () => {
          let body = "";
          for await (const chunk of request) body += chunk;
          const { method, params } = JSON.parse(body);
          if (method.endsWith("/poll")) pollRequests++;
          const result = await owner!.request(method, params);
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(result));
        })().catch(() => { response.statusCode = 500; response.end("Fixture request failed"); });
        return;
      }
      if (request.url === "/authorize") { response.end("Synthetic authorization page"); return; }
      if (request.url !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:var(--color-background-primary);color:var(--color-text)}#root{container:settings-panel/inline-size;min-height:100vh;padding:16px;box-sizing:border-box}</style><div id="root"></div><script type="module" src="/device-probe.tsx"></script></html>');
    }); },
  }],
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const results: unknown[] = [];
try {
  await vite.listen();
  const url = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const [index, recovery] of ["reload", "pageshow", "focus", "visibilitychange"].entries()) {
    pollRequests = 0; usageRequests = 0;
    owner = await CodexAccountService.start({ executable: process.execPath, dataDirectory: join(root, String(index)),
      nativeCodexHomeDirectory: join(root, "unused-native"),
      fetch: async () => { usageRequests++; return Response.json({ plan_type: "pro", rate_limit_reset_credits: { available_count: 2 } }); },
      createMaintenanceClient: async home => {
        const listeners = new Set<(method: string, params: unknown) => void>();
        complete = async () => {
          await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: {
            access_token: "synthetic-access", refresh_token: "synthetic-refresh", account_id: `synthetic-${index}`,
            id_token: `e30.${Buffer.from(JSON.stringify({ email: "mobile@example.test" })).toString("base64url")}.fixture`,
          } }), { mode: 0o600 });
          for (const listener of listeners) listener("account/login/completed", { loginId: "fixture-login", success: true });
        };
        return {
          request: async (method: string) => {
            assert.equal(method, "account/login/start");
            return { type: "chatgptDeviceCode", loginId: "fixture-login", verificationUrl: `${url}/authorize`, userCode: "TEST-1234" };
          },
          subscribeNotification: listener => { listeners.add(listener); return () => listeners.delete(listener); },
          close: async () => { listeners.clear(); },
        } as CodexMaintenanceClient;
      },
    });
    const page = await browser.newPage({ viewport: { width: index === 2 ? 1440 : 390, height: 900 }, colorScheme: index % 2 ? "dark" : "light" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value;");
    await page.goto(url);
    await page.getByRole("button", { name: "添加账户" }).click();
    await page.getByText("在浏览器中登录", { exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await page.getByText("TEST-1234", { exact: true }).waitFor();
    if (recovery === "reload") await page.goto(`${url}/authorize`);
    else await page.evaluate(() => Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }));
    const pollsBeforeCompletion = pollRequests;
    await complete!();
    // Read real server state, never call deviceLogin/poll to drive persistence.
    let accounts: any[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      accounts = (await owner.request("opencraft/codex/accounts/list", {}) as { accounts: any[] }).accounts;
      if (accounts.length && accounts[0].resetCredits) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].resetCredits?.availableCount, 2, "completion also refreshes subscription without browser polling");
    assert.equal(pollRequests, pollsBeforeCompletion, "server completion must not require a browser poll");
    assert.equal(usageRequests, 1);
    if (recovery === "reload") await page.goto(url);
    else await page.evaluate(event => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      (event === "visibilitychange" ? document : window).dispatchEvent(new Event(event));
    }, recovery);
    await page.locator(".engine-account__row").waitFor();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(await page.locator(".engine-account__reset-credits strong").textContent(), "2 张");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 });
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(output, `${recovery}.png`), fullPage: true });
    results.push({ recovery, width: index === 2 ? 1440 : 390, serverSavedWithoutPoll: true, usageRequests, accounts: accounts.length, errors });
    await page.close();
    await owner.close(); owner = undefined;
  }
  await writeFile(join(output, "result.json"), JSON.stringify({ passed: true, boundary: "real account owner and UI; synthetic native authorization/usage, Chromium mobile viewport", results }, null, 2));
  console.log(JSON.stringify({ passed: true, cases: results.length, output }));
} finally {
  await browser?.close(); await owner?.close(); await vite.close(); await rm(root, { recursive: true, force: true });
}
