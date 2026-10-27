import assert from "node:assert/strict";
import { createServer } from "vite";

const source = `
import React,{useLayoutEffect,useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {createWorkbenchPanelReactRuntime} from '@opencraft/workbench-panels-react';
import {createCloudDesktopWorkbenchPanelPlugin} from '/plugins/cloud-desktop/src/index.tsx';
const runtime=await createWorkbenchPanelReactRuntime(),listeners=new Set();
let target=null,renders=0;
const notify=()=>{for(const fn of [...listeners])fn()};
const backend={resolveTarget:()=>target,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},prepare:async()=>{throw Error('No remote desktop in fixture')}};
await runtime.install(createCloudDesktopWorkbenchPanelPlugin({backend,surfaces:{mount:()=>{throw Error('No media in fixture')}}}));
function Toolbar(){
 const actions=useSyncExternalStore(runtime.panels.subscribeToolbarActions,runtime.panels.getToolbarActionSnapshot);
 ++renders;useLayoutEffect(notify);
 return <main><span data-ready>{renders}</span>{actions.filter(a=>a.isAvailable({ownerId:'view',resourceOwnerId:'scope',hostId:'host',cwd:null})).map(a=><button key={a.id}>{a.label}</button>)}</main>;
}
window.fixture={notify,enable:value=>{target=value?{conversationId:'scope',serverId:'server',environmentId:'env',principalId:'principal'}:null;notify()},renders:()=>renders};
createRoot(document.getElementById('root')).render(<Toolbar/>);
`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, esbuild: { jsx: "automatic" },
  cacheDir: "node_modules/.vite-desktop-toolbar-feedback",
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "desktop-toolbar-feedback", resolveId: id => id === "/toolbar-feedback.tsx" ? id : null,
    load: id => id === "/toolbar-feedback.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== "/") return next();
      res.setHeader("content-type", "text/html");
      res.end('<div id="root"></div><script type="module" src="/toolbar-feedback.tsx"></script>');
    }); },
  }],
});
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await vite.listen(); browser = await chromium.launch({ headless: true });
  const page = await browser.newPage(); const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript("window.__name=value=>value");
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
  await page.locator("[data-ready]").waitFor();
  await page.evaluate(() => { for (let index = 0; index < 20; ++index) (window as any).fixture.notify(); });
  assert.equal(await page.locator("[data-ready]").innerText(), "1");
  await page.evaluate(() => (window as any).fixture.enable(true));
  await page.getByRole("button", { name: "Desktop", exact: true }).waitFor();
  await page.evaluate(() => (window as any).fixture.enable(false));
  await page.getByRole("button", { name: "Desktop", exact: true }).waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, unchangedNotifications: 20, availabilityChanges: 2,
    renders: await page.evaluate(() => (window as any).fixture.renders()), errors }));
} finally { await browser?.close(); await vite.close(); }
