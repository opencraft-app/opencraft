import assert from "node:assert/strict";
import { createServer } from "vite";

// Real Sidebar + shared theme/Intl, no duplicate test-only rendering.
const source = `
import React,{useState}from'react';
import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';
import{Sidebar}from'/apps/workbench-web/src/components/sidebar.tsx';
import{SidebarLayoutStore}from'@opencraft/sidebar-layout';
import{legacyDirectServerProjectionFromHost}from'@opencraft/workbench-runtime';
import{initializeAppearanceTheme,setThemePreference}from'/apps/workbench-web/src/appearance-theme.ts';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_scope,doc)=>doc});
const actions=[];
function row(i,remote=false){const hostId=remote?'ssh:remote':'local';return{id:'thread-'+i,title:'Task '+i,project:'workspace',status:'ready',updatedAt:Date.now()-i*1000,connectionHostId:hostId,connectionHostLabel:remote?'Remote':'Local',...legacyDirectServerProjectionFromHost({hostId,hostKind:remote?'remote-ssh':'local',label:remote?'Remote':'Local'})};}
function App(){const[threads,setThreads]=useState([]);const[catalogs,setCatalogs]=useState([{hostId:'ssh:remote',label:'Remote',phase:'loading'}]);const[discovery,setDiscovery]=useState(null);
window.fixture={setThreads,setCatalogs,setDiscovery,row,actions,setThemePreference};
const threadActions={onRename:async()=>{},onFork:async()=>{},onArchive:async()=>{},onDelete:async()=>{},onSetPinned:async(target,pinned)=>{actions.push({pin:target.threadId,pinned});setThreads(rows=>rows.map(row=>row.id===target.threadId&&row.connectionHostId===target.hostId?{...row,pinned}:row));}};
return <div style={{height:'100vh',width:300,display:'flex',flexDirection:'column'}}><Sidebar threads={threads} activeHostId='local' activeThreadId='thread-0' sidebarLayout={layout} threadActions={threadActions} threadCapabilities={hostId=>({pin:hostId==='ssh:remote',rename:false,archive:false,fork:false,delete:false})} threadCatalogs={catalogs} threadCatalogDiscovery={discovery} onRetryThreadCatalogDiscovery={()=>{actions.push('discovery-read');setDiscovery('loading');}} onRetryThreadCatalog={id=>{actions.push(id);setCatalogs([{hostId:id,label:'Remote',phase:'loading'}]);}} onSelectThread={(hostId,id)=>actions.push({hostId,id})} onNewTask={()=>{}} onOpenSettings={()=>{}} /></div>;}
createIntlTestRoot(document.getElementById('root')).render(<App/>);`;
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-sidebar-catalog", esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "sidebar-catalog-fixture",
    resolveId: id => id === "/catalog-probe.tsx" ? id : null,
    load: id => id === "/catalog-probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== "/") return next();
      res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/catalog-probe.tsx"></script>');
    }); },
  }],
});
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
let browser: any;
const evidence: unknown[] = [];
try {
  await vite.listen();
  const origin = vite.resolvedUrls!.local[0]!;
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const touch of [false, true]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 900, height: 844 }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(origin);
    await page.locator('.sidebar-tasks[aria-busy="true"]').waitFor({ state: "attached" });
    await page.evaluate(theme => (window as any).fixture.setThemePreference(theme), theme);
    assert.equal(await page.locator(".sidebar-activity-empty").count(), 0, "pending is not empty");
    assert.equal(await page.locator(".sidebar-catalog-feedback").count(), 0, "loading has no feedback row or spacer");
    assert.equal(await page.locator(".sidebar-tasks .workbench-loading-spinner").count(), 0, "catalog loading has no visible spinner");
    await page.evaluate(() => {
      const f = (window as any).fixture;
      f.setThreads([f.row(0)]);
      f.setCatalogs([{ hostId: "ssh:remote", label: "Remote", phase: "error" }]);
    });
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await retry.waitFor();
    assert.equal(await page.locator(".sidebar-activity-item").count(), 1, "one failed server retains healthy rows");
    await page.evaluate(() => { (window as any).healthyRow = document.querySelector(".sidebar-activity-item"); });
    if (process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR}/catalog-error-${touch ? "touch" : "desktop"}-${theme}.png` });
    if (touch) await retry.tap(); else await retry.click();
    await page.locator('.sidebar-tasks[aria-busy="true"]').waitFor({ state: "attached" });
    assert.equal(await page.locator(".sidebar-catalog-feedback").count(), 0, "retry removes the error without adding loading chrome");
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.actions), ["ssh:remote"], "retry is host-scoped and does not select a Thread");
    assert.equal(await page.locator(".sidebar-activity-item").count(), 1);
    assert.equal(await page.evaluate(() => (window as any).healthyRow === document.querySelector(".sidebar-activity-item")), true, "retry must not remount a healthy row");
    await page.evaluate(() => { const f = (window as any).fixture; f.setCatalogs([]); f.setDiscovery('error'); });
    await page.getByText("Couldn't load remote connections", { exact: true }).waitFor();
    assert.equal(await page.locator('.sidebar-activity-item').count(), 1, "discovery failure retains healthy local history");
    if (touch) await retry.tap(); else await retry.click();
    await page.locator('.sidebar-tasks[aria-busy="true"]').waitFor({ state: "attached" });
    assert.equal(await page.locator('.sidebar-catalog-feedback').count(), 0);
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.actions), ["ssh:remote", "discovery-read"]);
    assert.equal(await page.evaluate(() => (window as any).healthyRow === document.querySelector('.sidebar-activity-item')), true);
    const loadingTop = (await page.locator('.sidebar-activity-item').boundingBox())!.y;
    await page.evaluate(() => (window as any).fixture.setDiscovery(null));
    await page.locator('.sidebar-tasks[aria-busy="false"]').waitFor({ state: "attached" });
    assert.equal((await page.locator('.sidebar-activity-item').boundingBox())!.y, loadingTop, "loading completion must not move healthy history");
    assert.equal(await page.evaluate(() => (window as any).healthyRow === document.querySelector('.sidebar-activity-item')), true);
    await page.evaluate(() => {
      const f = (window as any).fixture;
      f.setDiscovery(null);
      f.setThreads(Array.from({ length: 13 }, (_, i) => f.row(i, i >= 10)));
      f.setCatalogs([{ hostId: "ssh:remote", label: "Remote", phase: "ready" }]);
    });
    const more = page.getByRole("button", { name: "Show more (3 remote)", exact: true });
    await more.waitFor();
    assert.equal(await page.locator(".sidebar-activity-item").count(), 10);
    if (process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR}/catalog-more-${touch ? "touch" : "desktop"}-${theme}.png` });
    if (touch) await more.tap(); else await more.click();
    await page.getByRole("button", { name: "Show less", exact: true }).waitFor();
    assert.equal(await page.locator(".sidebar-activity-item").count(), 13);
    assert.equal(await page.locator(".sidebar-catalog-feedback").count(), 0);
    await page.getByRole("button", { name: "Show less", exact: true }).click();
    await page.evaluate(() => {
      const f = (window as any).fixture;
      f.setThreads([...Array.from({ length: 13 }, (_, i) => f.row(i, i >= 10)), { ...f.row(100, true), pinned: true }]);
    });
    const pinnedSection = page.getByRole("region", { name: "置顶", exact: true });
    await pinnedSection.waitFor();
    assert.equal(await pinnedSection.locator(".sidebar-activity-item").count(), 1);
    assert.equal(await page.locator(".sidebar-activity-item").count(), 11, "pins do not consume ten recent slots");
    assert.equal(await page.getByRole("button", { name: "Task 0 的操作", exact: true }).count(), 0, "unsupported host hides the operation trigger");
    const trigger = page.getByRole("button", { name: "Task 100 的操作", exact: true });
    if (!touch) await pinnedSection.locator(".sidebar-activity-row").hover();
    if (touch) await trigger.tap(); else await trigger.click();
    const unpin = page.getByRole("menuitem", { name: "取消置顶", exact: true });
    await unpin.waitFor();
    if (touch) await unpin.tap(); else await unpin.click();
    await pinnedSection.waitFor({ state: "detached" });
    assert.equal(await page.locator(".sidebar-activity-item").count(), 10);
    assert.equal(await page.evaluate(() => (window as any).fixture.actions.at(-1).pinned), false);
    await page.getByRole("button", { name: "Show more (4 remote)", exact: true }).click();
    if (!touch) await page.locator(".sidebar-activity-row").filter({ has: page.getByRole("button", { name: "Task 100 的操作", exact: true }) }).hover();
    await page.getByRole("button", { name: "Task 100 的操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "置顶", exact: true }).click();
    await pinnedSection.waitFor();
    assert.equal(await pinnedSection.locator(".sidebar-activity-item").count(), 1, "pin appears once after acknowledgement");
    assert.equal(await page.locator(".sidebar-activity-item").count(), 14);
    await page.evaluate(() => (window as any).fixture.setThreads([]));
    await page.locator(".sidebar-activity-empty").waitFor();
    assert.deepEqual(errors, []);
    evidence.push({ touch, theme, reducedMotion: true, quietLoading: true, loadingNotEmpty: true, stableHistoryGeometry: true, failedHostIsolation: true, scopedRetry: true, discoveryRetryWithoutProfiles: true, hiddenRemoteEntry: true, successfulEmpty: true, nativePinPresentation: true, unsupportedPinHidden: true, pinDoesNotConsumeRecentBudget: true });
    await context.close();
  }
  console.log(JSON.stringify({ ok: true, realSidebar: true, evidence }));
} finally { await browser?.close(); await vite.close(); }
