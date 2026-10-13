import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { createServer } from "vite";
import { TencentOaServerPlugin } from "../plugins/tencentoa/src/server";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const token = Buffer.alloc(32, 97);
const photo = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6G1sAAAAASUVORK5CYII=", "base64");
const service = new TencentOaServerPlugin(token, { fetcher: (async () => new Response(photo, { headers: { "content-type": "image/png" } })) as typeof fetch });
let unauthorized = false;
function headers(loginName: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const protectedPart = Buffer.from(JSON.stringify({ alg: "dir", enc: "A256GCM" })).toString("base64url");
  const iv = Buffer.alloc(12, 9), cipher = createCipheriv("aes-256-gcm", token, iv);
  cipher.setAAD(Buffer.from(protectedPart));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ LoginName: loginName, StaffId: 123, Expiration: new Date(Date.now() + 60_000).toISOString(), open_id: "private-fixture" })), cipher.final()]);
  return { timestamp, signature: createHash("sha256").update(timestamp + token.toString() + "fixture,,," + timestamp).digest("hex").toUpperCase(), "x-rio-seq": "fixture",
    "x-tai-identity": [protectedPart, "", iv.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".") };
}
const entry = `
import React,{useState,useSyncExternalStore} from 'react';import {createIntlTestRoot as createRoot} from '/tests/fixtures/intl-root.tsx';
import {TencentOaController} from '/plugins/tencentoa/src/controller.ts';
import {createTencentOaAccountContribution} from '/plugins/tencentoa/src/account.ts';
import {createEmployeeIdentityView} from '/plugins/tencentoa/src/view.tsx';
import {ShellNavigationFooter,useShellNavigation} from '/apps/workbench-web/src/components/shell-navigation/index.tsx';
import {ModalHost} from '/apps/workbench-web/src/components/modal/index.ts';
import {initializeAppearanceTheme} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();const controller=new TencentOaController();window.controller=controller;
const View=createEmployeeIdentityView(controller),account=createTencentOaAccountContribution(controller);
function App(){const[details,setDetails]=useState(false);const snapshot=useSyncExternalStore(account.subscribe,account.getSnapshot,account.getSnapshot);
const navigation=useShellNavigation({viewportWidth:innerWidth,contextWidth:250,contextAvailable:true,sidecarOpen:true,enabled:true,allowDock:false});
return <><aside className='app-shell-sidecar' style={{position:'relative',width:'min(250px,100vw)',height:'100vh',display:'flex',flexDirection:'column'}}>
<div style={{flex:1}}>Local tasks</div><ShellNavigationFooter controller={navigation}
config={{actions:[],onOpenSettings:()=>{},account:{snapshot,onOpen:()=>setDetails(true),onRefresh:account.refresh}}}/></aside>
<ModalHost requests={details?[{id:'employee',label:'员工身份',appearance:'utility',size:'wide',dismissOnOutsidePress:false,content:<View/>,onDismiss:()=>setDetails(false)}]:[]}/></>}
createRoot(document.getElementById('root')).render(<App/>);void controller.refresh();
`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "@deepseek-ai/cordis", "@lightvela/vela-chat-client-core", "@tencentcloud/chat", "tim-upload-plugin"] },
  optimizeDeps: { include: ["react", "react-dom/client", "@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu"] },
  cacheDir: "node_modules/.vite-tencentoa", esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, hmr: false }, plugins: [{
  name: "tencentoa-fixture", resolveId: id => id === "/probe.tsx" ? id : null, load: id => id === "/probe.tsx" ? entry : null,
  configureServer(server) { server.middlewares.use((request, response, next) => {
    if (request.url?.startsWith("/__opencraft_tencentoa/")) {
      // Synthetic trusted gateway, used exclusively by this local smoke fixture.
      if (!unauthorized) Object.assign(request.headers, headers(request.headers.cookie?.includes("employee=two") ? "employee.two" : "employee.one"));
      service.handle(request, response); return;
    }
    if (request.url !== "/") return next();
    response.setHeader("content-type", "text/html"); response.end('<div id="root"></div><script type="module" src="/probe.tsx"></script>');
  }); },
}] });
let browser: any;
try {
  await vite.listen(); const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  for (const width of [390, 1280]) for (const colorScheme of ["light", "dark"]) {
    unauthorized = false;
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme }), page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", (error: Error) => { errors.push(error.message); console.error("Fixture page error:", error.message); });
    await context.addCookies([{ name: "employee", value: "two", url: origin }]);
    await page.goto(origin);
    await page.waitForFunction(() => (window as any).controller?.getSnapshot().phase === "ready");
    assert.equal(await page.evaluate(() => (window as any).controller.getSnapshot().identity?.loginName), "employee.two");
    const entrance = page.locator('.shell-navigation__entrance[data-surface="account"]');
    await entrance.waitFor();
    await page.waitForFunction(() => {
      const image = document.querySelector('.shell-navigation__entrance[data-surface="account"] img') as HTMLImageElement | null;
      return image !== null && image.complete && image.naturalWidth > 0;
    });
    assert.equal(await entrance.locator('.shell-navigation__name').textContent(), "employee.two");
    assert.equal(await page.getByRole("dialog").count(), 0);
    await entrance.click();
    await page.locator('.shell-navigation__peek').getByRole("button", { name: /employee.two/ }).click();
    await page.getByText("员工编号", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: /Sign out|退出登录/ }).count(), 0);
    assert.equal(await page.getByText("employee.one", { exact: true }).count(), 0);
    assert.equal(await page.getByText("private-fixture", { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    unauthorized = true; await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.getByText("未登录", { exact: true }).waitFor();
    assert.equal(await page.getByText("employee.two", { exact: true }).count(), 0);
    assert.equal(await entrance.textContent(), "员工身份");
    assert.deepEqual(errors, []); await context.close();
  }
  console.log("Tencent OA real footer/details: mobile/desktop, light/dark, automatic identity, IOA-owned employee avatar, isolation and revocation passed");
} finally { await browser?.close(); await vite.close(); service.close(); token.fill(0); }
