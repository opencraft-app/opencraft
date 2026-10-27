import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";

// Two real browser pages reproduce the retained v1 connection and v2 upgrade.
// Only synthetic local profiles are used; no Host or account is contacted.
const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const engine = process.env.OPENCRAFT_STORAGE_BROWSER ?? "chromium";
if (engine !== "webkit" && engine !== "chromium") throw new Error("Storage smoke supports webkit or chromium");
const browserType = playwright[engine];
const html = await readFile("apps/workbench-web/index.html", "utf8");
const recoveryScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(script => script.includes("isResizeObserverDeliveryWarning"));
const source = `
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {IndexedDbHostConnectionProfileStore} from '/apps/workbench-web/src/runtime/indexeddb-host-profile-store.ts';
import {RuntimeErrorBoundary} from '/apps/workbench-web/src/components/runtime-error-boundary.tsx';
import '/apps/workbench-web/src/styles/app.scss';
const name='storage-recovery-fixture';
const profile={hostId:'saved',displayName:'Saved server',providerId:'opencraft.websocket',providerConfig:{url:'wss://saved.invalid/appserver'},providerConfigVersion:1,hostKind:'durable',enabled:true,autoConnect:false,includeInSidebar:true,credentialRef:null,transportEndpoint:null,executionLocation:'Saved server',workspaceBrowseRoots:['/workspace'],revision:4,machineIdentity:null,agent:null};
if(location.pathname==='/legacy'){
 const req=indexedDB.open(name,1);
 req.onupgradeneeded=()=>req.result.createObjectStore('profiles',{keyPath:'hostId'});
 req.onsuccess=()=>{window.fixtureLegacy=req.result;const tx=req.result.transaction('profiles','readwrite');tx.objectStore('profiles').put(profile);tx.oncomplete=()=>document.body.dataset.ready='true'};
}else if(location.pathname==='/upgrade'){
 const req=indexedDB.open(name,3);
 req.onsuccess=()=>{req.result.close();document.body.dataset.ready='true'};
}else{
 function App(){
  const [state,setState]=useState({phase:'loading'});
  useEffect(()=>{
   let store=null,disposed=false;
   let factory=indexedDB;
   if(location.pathname==='/timeout'){
    factory={open:()=>new EventTarget()};
    const native=window.setTimeout.bind(window);
    window.setTimeout=(fn,delay,...args)=>native(fn,delay===10000?25:delay,...args);
   }
   void IndexedDbHostConnectionProfileStore.open({databaseName:name,factory}).then(value=>{store=value;if(disposed){value.close();return}setState({phase:'ready',profile:value.getSnapshot().profiles[0]})},error=>{if(!disposed){const event=new Event('vite:preloadError',{cancelable:true});event.payload=error;window.dispatchEvent(event);if(!event.defaultPrevented)setState({phase:'error',error})}});
   return()=>{disposed=true;store?.close()};
  },[]);
  if(state.phase==='error')throw state.error;
  return state.phase==='ready'?<main><h1>工作台已打开</h1><p data-profile>{state.profile?.displayName}</p></main>:<main role="status">正在加载</main>;
 }
 createRoot(document.getElementById('root')).render(<RuntimeErrorBoundary><App/></RuntimeErrorBoundary>);
}
`;
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, esbuild: { jsx: "automatic" },
  cacheDir: "node_modules/.vite-storage-recovery",
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "host-profile-storage-fixture",
    resolveId: id => id === "/storage-recovery.tsx" ? id : null,
    load: id => id === "/storage-recovery.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url === "/__opencraft_runtime_error") { res.statusCode = 204; res.end(); return; }
      if (!["/legacy", "/workbench", "/upgrade", "/timeout"].includes(req.url ?? "")) return next();
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end('<html><head><title>Storage recovery</title></head><body><div id="root"></div><script>'+recoveryScript+'</script><script type="module" src="/storage-recovery.tsx"></script></body></html>');
    }); },
  }],
});
let browser: Awaited<ReturnType<typeof browserType.launch>> | undefined;
try {
  await vite.listen();
  browser = await browserType.launch({ headless: true,
    ...(engine === "chromium" ? { executablePath: browserType.executablePath() } : {}),
  });
  const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  const evidence = process.env.OPENCRAFT_STORAGE_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const mode of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 960, height: 720 } });
    try {
      await context.addInitScript(() => { (window as any).__name = (value: unknown) => value; });
      const legacy = await context.newPage();
      await legacy.goto(`${origin}/legacy`);
      await legacy.waitForFunction(() => document.body.dataset.ready === "true");
      const page = await context.newPage();
      await page.goto(`${origin}/workbench`);
      await page.getByRole("heading", { name: "暂时无法打开工作台" }).waitFor();
      await page.evaluate(mode => {
        document.documentElement.dataset.theme = mode;
        document.documentElement.className = `${mode} electron-${mode}`;
      }, mode);
      assert.match(await page.getByRole("alert").innerText(), /关闭此站点的其他标签页/);
      assert.doesNotMatch(await page.getByRole("alert").innerText(), /IndexedDB|BrowserStorageError|storage-recovery-fixture/);
      assert.equal(await page.getByRole("status").count(), 0);
      if (evidence) await page.screenshot({ path: join(evidence, `blocked-${mode}.png`) });
      await legacy.close();
      await page.getByRole("button", { name: "重新加载" }).click();
      await page.getByRole("heading", { name: "工作台已打开" }).waitFor();
      assert.equal(await page.locator("[data-profile]").innerText(), "Saved server");
      const upgrade = await context.newPage();
      await upgrade.goto(`${origin}/upgrade`);
      await upgrade.waitForFunction(() => document.body.dataset.ready === "true");
      // A pending request with no blocked/error event also leaves the spinner.
      const timeout = await context.newPage();
      await timeout.goto(`${origin}/timeout`);
      await timeout.getByRole("heading", { name: "暂时无法打开工作台" }).waitFor();
      assert.equal(await timeout.getByRole("status").count(), 0);
      assert.equal(await timeout.locator("#opencraft-release-failure").count(), 0);
      await timeout.evaluate(async () => {
        localStorage.setItem("retained-fixture", "saved");
        await (globalThis as any).__opencraftRecoverRelease(Object.assign(new Error("Browser storage timeout"), { name: "BrowserStorageError" }));
      });
      await timeout.getByRole("heading", { name: "暂时无法读取本地配置" }).waitFor();
      assert.equal(await timeout.evaluate(() => localStorage.getItem("retained-fixture")), "saved");
      assert.equal(await timeout.locator("[data-release-error]").isVisible(), false);
      if (evidence) await timeout.screenshot({ path: join(evidence, `early-storage-${mode}.png`) });
      console.log(JSON.stringify({ browser: engine, mode, blocked: "recovery shown", retry: "saved profile retained", versionchange: "upgrade completed", timeout: "recovery shown" }));
    } finally { await context.close(); }
  }
} finally { await browser?.close(); await vite.close(); }
