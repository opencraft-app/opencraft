import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

const { chromium, _electron } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = await mkdtemp(join(process.env.OPENCRAFT_EXECUTION_OWNER_ARTIFACT_DIR ?? tmpdir(), "opencraft-execution-owner-"));
const source = `
import React from 'react';import{createIntlTestRoot as createRoot}from'/tests/fixtures/intl-root.tsx';
import{Sidebar}from'/apps/workbench-web/src/components/sidebar.tsx';
import{initializeAppearanceTheme}from'/apps/workbench-web/src/appearance-theme.ts';
import{threadServerOrigin}from'@opencraft/workbench-runtime';
import{SidebarLayoutStore}from'@opencraft/sidebar-layout';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const storage={load:async()=>null,save:async(_,value)=>value};const layout=await SidebarLayoutStore.open(storage);
const now=Date.now()/1000;
const local=threadServerOrigin({serverId:'local-server',label:'Local'});
const hermes=threadServerOrigin({serverId:'remote-hermes',label:'Hermes Cloud'});
const ssh=threadServerOrigin({serverId:'ssh-server:9.134.163.40',label:'Remote SSH'});
const base={project:'opencraft',lineage:'root',time:'now',updatedAt:now,unread:false};
const threads=[
 {...base,id:'local',title:'Local task',status:'ready',connectionHostId:'local',connectionHostLabel:'Local',serverOrigin:local,serverRouteLocality:'local'},
 {...base,id:'hermes-running',title:'Hermes running',status:'running',updatedAt:now-1,connectionHostId:'hermes-route-a',connectionHostLabel:'Hermes route',serverOrigin:hermes,serverRouteLocality:'remote'},
 {...base,id:'hermes-ready',title:'Hermes ready',status:'ready',updatedAt:now-2,connectionHostId:'hermes-route-b',connectionHostLabel:'Hermes backup route',serverOrigin:hermes,serverRouteLocality:'remote'},
 {...base,id:'ssh',title:'SSH task',status:'review',updatedAt:now-3,connectionHostId:'ssh-route',connectionHostLabel:'Remote SSH',serverOrigin:ssh,serverRouteLocality:'remote'},
];
createRoot(document.getElementById('root')).render(<div style={{width:275,height:700}}><Sidebar threads={threads} activeHostId='local' activeThreadId='local' sidebarLayout={layout} onSelectThread={()=>{}} onNewTask={()=>{}} onOpenSettings={()=>{}} showFooter={false}/></div>);
`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", resolve: { dedupe: ["react", "react-dom"] }, esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0 }, plugins: [{
  name: "execution-owner-fixture", resolveId: id => id === "/probe.tsx" ? id : null, load: id => id === "/probe.tsx" ? source : null,
  configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== "/") return next(); res.setHeader("content-type", "text/html"); res.end('<div id="root"></div><script type="module" src="/probe.tsx"></script>'); }); },
}] });
let browser: any; let desktop: any;
try {
  await vite.listen(); const url = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}`; let page: any;
  if (process.env.OPENCRAFT_EXECUTION_OWNER_ELECTRON) {
    const entry = join(output, "main.cjs");
    await writeFile(entry, `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(output, "profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({width:480,height:700,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});w.loadURL(${JSON.stringify(url)});});app.on('window-all-closed',()=>app.quit());`);
    desktop = await _electron.launch({ executablePath: process.env.OPENCRAFT_EXECUTION_OWNER_ELECTRON, args: [entry], env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE")) });
    page = await desktop.firstWindow();
  } else { browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE }); page = await browser.newPage({ viewport: { width: 480, height: 700 } }); await page.goto(url); }
  await page.getByRole("button", { name: /Hermes running/ }).waitFor();
  assert.equal(await page.locator('.sidebar-activity-item__server-origin,.sidebar-activity-item__server-dot').count(),0);
  assert.equal(await page.locator('.sidebar-activity-item__project').count(),4);
  const projects = await page.locator('.sidebar-activity-item__project').allTextContents();
  assert.deepEqual(projects,['opencraft','opencraft','opencraft','opencraft']);
  const trailing = await page.locator('.sidebar-activity-item__trailing').evaluateAll((nodes: HTMLElement[]) => nodes.map(node => node.getBoundingClientRect().width));
  assert.ok(trailing.every(width => Math.abs(width - 18) < 1), JSON.stringify(trailing));
  assert.equal(await page.getByText('Hermes Cloud', { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(output, "execution-owner.png") });
  console.log(JSON.stringify({ output, projects, trailing, evidence: "Server marks omitted across routes; complete project badges; status independent; 480px no overflow" }));
} finally { await browser?.close(); await desktop?.close(); await vite.close(); }
