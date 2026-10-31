import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";
import { CodexAccountService } from "../../../packages/account-pool-host/src/codex-account-service.js";

const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? join(tmpdir(), "device-login-maintenance-smoke");
await mkdir(output, { recursive: true });
const data = await mkdtemp(join(tmpdir(), "device-login-maintenance-view-"));
const sessionId = "11111111-1111-4111-8111-111111111111";
const original = { status: "error" as const, message: "Login cancelled." };
const retained = { imageAffinities: [], resetReceipts: [], loginReceipts: [[sessionId,
  { expiresAt: Date.now() + 60_000, result: original }]] as any };
const source = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {createCodexAccountsView} from '/plugins/builtin-agents/src/codex-accounts/view.tsx';
import {CodexAccountsService} from '/plugins/builtin-agents/src/codex-accounts/service.ts';
import {buildOpenCraftThemeCssProperties,opencraftNeutralThemePalette} from '/packages/design-system/src/theme-engine.ts';
import '/apps/workbench-web/src/styles/app.scss';
import '/apps/workbench-web/src/styles/settings-panel.scss';
import '/apps/workbench-web/src/styles/engine-accounts.scss';
const mode='light';document.documentElement.dataset.theme=mode;
for(const [key,value]of Object.entries(buildOpenCraftThemeCssProperties(mode,opencraftNeutralThemePalette[mode])))document.documentElement.style.setProperty(key,value);
const service=new CodexAccountsService(async(_host,method,params)=>{
 const r=await fetch('/fixture/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,params})});return r.json();
},'fixture');
await service.refresh();
// Reconstruct the client's existing pre-migration login; this synthetic start
// response never dispatches a new Native login or cancellation.
window.maintenanceProbe=async()=>{await service.startDeviceLogin();await service.pollDeviceLogin()};
const View=createCodexAccountsView(service);createRoot(document.getElementById('root')).render(<View/>);
`;
let owner: CodexAccountService | undefined;
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "maintenance-login-view", resolveId: id => id === "/probe.tsx" ? id : null,
    load: id => id === "/probe.tsx" ? source : null,
    configureServer(vite) { vite.middlewares.use((req, res, next) => {
      if (req.url === "/fixture/rpc") {
        void (async () => {
          let body = ""; for await (const chunk of req) body += chunk;
          const { method, params } = JSON.parse(body);
          const result = method.endsWith("/start") ? { sessionId, verificationUrl: "https://example.test/device", userCode: "FIXTURE", expiresAt: Date.now() + 60_000 }
            : await owner!.request(method, params);
          res.setHeader("content-type", "application/json"); res.end(JSON.stringify(result));
        })().catch(() => { res.statusCode = 500; res.end("{}"); }); return;
      }
      if (req.url !== "/") return next();
      res.setHeader("content-type", "text/html");
      res.end('<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:var(--color-background-primary);color:var(--color-text)}#root{container:settings-panel/inline-size;min-height:100vh;padding:16px;box-sizing:border-box}</style><div id="root"></div><script type="module" src="/probe.tsx"></script></html>');
    }); } }],
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const metadata = join(data, "device-login-maintenance"); await mkdir(metadata, { mode: 0o700 });
  await writeFile(join(metadata, `${sessionId}.json`), JSON.stringify({ version: 1, kind: "device-login-maintenance",
    operationId: "maintenance-view", source: { owner: "fixture-owner", epoch: 1, operationId: "maintenance-view", fence: "fixture-fence" },
    sessionId, cancelAttempted: true, terminal: true, disposition: "maintenance-interrupted", originalResult: original,
    resultSha256: createHash("sha256").update(JSON.stringify({ message: original.message, status: original.status })).digest("hex"),
  }), { mode: 0o600 });
  owner = await CodexAccountService.start({ executable: process.execPath, dataDirectory: data,
    nativeCodexHomeDirectory: join(data, "native"), proxyPort: 0,
    ownerHandoff: { admissionOpen: () => false, onUncertain: () => {}, retained },
    createMaintenanceClient: async () => { throw new Error("No Native login replay in view smoke"); } });
  await server.listen();
  const url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors: string[] = [];page.on("pageerror", error => errors.push(error.message));
    await page.goto(url);
    await page.getByRole("heading", { name: "Codex 账户" }).waitFor();
    await page.waitForFunction(() => typeof (window as any).maintenanceProbe === "function");
    await page.evaluate(async () => { await (window as any).maintenanceProbe(); });
    assert.deepEqual(errors, []);
    await page.getByRole("alert").filter({ hasText: "登录被维护中断，请重新登录" }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "Codex 账户" }).count(), 1);
    await page.screenshot({ path: join(output, `maintenance-${width}.png`), fullPage: true });
    await page.close();
  }
  assert.deepEqual(owner.retainedState(), retained);
  console.log(JSON.stringify({ status: "passed", widths: [390, 1440], component: "CodexAccountsSettings",
    realAccountPoll: true, originalReceiptUnchanged: true, nativeLoginReplay: false, fullShell: false, output }));
} finally { await browser?.close(); await server.close(); await owner?.close(); await rm(data, { recursive: true, force: true }); }
