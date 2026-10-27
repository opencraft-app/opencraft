import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const output = await mkdtemp(join(tmpdir(), "opencraft-file-tree-model-"));
const baseline = process.env.OPENCRAFT_FILE_TREE_BASELINE_SOURCE
  ? await readFile(process.env.OPENCRAFT_FILE_TREE_BASELINE_SOURCE, "utf8") : null;
const runtime = `
import {useSyncExternalStore} from 'react';
const listeners=new Set();
let snapshot={hostId:'tree-fixture',conversation:{execution:{cwd:'/fixture',runtimeWorkspaceRoots:['/fixture']}}};
const reads=[];let lateResolve;let entries=[{fileName:'a-nested',isDirectory:true,isFile:false},{fileName:'b-error',isDirectory:true,isFile:false},{fileName:'c-late',isDirectory:true,isFile:false},{fileName:'draft.ts',isDirectory:false,isFile:true},...Array.from({length:5000},(_,i)=>({fileName:'report-'+String(i).padStart(4,'0')+'.html',isDirectory:false,isFile:true}))];
const runtime={resources:{host:{canRequest:method=>method==='fuzzyFileSearch/sessionStart'},fileSystem:{
async getMetadata(path){return {isFile:path!=='/fixture',isDirectory:path==='/fixture',modifiedAtMs:0,size:100}},
async readFile(path){return {dataBase64:btoa(path.endsWith('.ts')?'const original = 1;':'<html><body><h1>Persistent preview</h1></body></html>')}},
async readDirectory(path){reads.push(path);if(path.endsWith('b-error'))throw new Error('fixture directory error');if(path.endsWith('c-late'))return new Promise(resolve=>lateResolve=resolve);return {entries:path==='/fixture'?entries:[{fileName:'child.html',isDirectory:false,isFile:true}]}},
async createFuzzyFileSearchSession(options){return {update:async()=>{options.onUpdated({files:[{root:'/fixture',path:'a-nested/child.html',file_name:'child.html',match_type:'file'}]});options.onCompleted()},stop:async()=>{}}}
}}};
window.fixtureRuntime={reads,listeners,tick(){snapshot={...snapshot};for(const listener of listeners)listener()},resolveLate(){lateResolve({entries:[{fileName:'late.html',isDirectory:false,isFile:true}]})},shrink(){entries=[{fileName:'remaining.html',isDirectory:false,isFile:true}]}};
export const useAppServerRuntime=()=>runtime;
export const useBlobResources=()=>window.fixtureBlobs;
export const useAppServerSnapshot=()=>useSyncExternalStore(listener=>{listeners.add(listener);return()=>listeners.delete(listener)},()=>snapshot);`;
const source = `
import '/apps/workbench-web/src/runtime/web-crypto-compat.ts';
import React,{useState} from 'react';import {Context} from '@deepseek-ai/cordis';import {BlobResourceService} from '@opencraft/blob-resources';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {WorkspaceResourcePanel} from '/apps/workbench-web/src/panels/workspace-resource-panel.tsx';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const context=new Context();await context.plugin(BlobResourceService);window.fixtureBlobs=context.blobResources;
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
function App(){const[sidebar,setSidebar]=useState(innerWidth>=700);const[panelOpen,setPanelOpen]=useState(innerWidth>=700);window.fixture={setSidebar,setThemePreference,client,setPanelOpen};
const panel=<div style={{height:'100%',width:'100%'}}><WorkspaceResourcePanel tab={{id:'files',kind:'resource',title:'Files',resource:'/fixture',region:'right',closable:true,preview:false}}/></div>;
return <AppShell layoutScope='fixture' header={<span>Workspace</span>} floatingSidebarHeader={()=>null} leftPanel={<div>Sidebar</div>} sidebarOpen={sidebar} sidebarWidth={260} onSidebarCollapse={()=>setSidebar(false)} onSidebarExpand={()=>setSidebar(true)} onSidebarResizeEnd={()=>{}} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} rightPanel={panel} rightPanelOpen={panelOpen} rightPanelFullWidth={true} onRightPanelOpenChange={setPanelOpen}><p>Conversation</p></AppShell>}
createIntlTestRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><App/></QueryClientProvider>);`;
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  optimizeDeps: { include: ["@codemirror/lang-javascript", "@codemirror/lang-css", "codemirror", "@codemirror/language", "@codemirror/state", "@codemirror/view", "@lezer/highlight"] },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [react(), {
    name: "workspace-tree-fixture", enforce: "pre",
    resolveId(id, importer) {
      if (id.endsWith("/appserver-runtime-context") && importer?.includes("/panels/")) return "/tree-runtime.ts";
      return ["/tree-runtime.ts", "/tree-fixture.tsx"].includes(id) ? id : null;
    },
    load: id => baseline !== null && id.endsWith("/panels/workspace-resource-panel.tsx") ? baseline
      : id === "/tree-runtime.ts" ? runtime : id === "/tree-fixture.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== "/") return next();
      res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tree-fixture.tsx"></script>');
    }); },
  }],
});
let browser: any;
try {
  await vite.listen();
  const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const evidence = [];
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    console.log(JSON.stringify({ phase: "start", width, theme, output }));
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript(() => {
      (window as any).__name = (value: unknown) => value;
      (window as any).comparisons = 0;
      const descriptor = Object.getOwnPropertyDescriptor(Intl.Collator.prototype, "compare")!;
      const cache = new WeakMap();
      Object.defineProperty(Intl.Collator.prototype, "compare", { ...descriptor, get() {
        if (!cache.has(this)) {
          const compare = descriptor.get!.call(this);
          cache.set(this, (a: string, b: string) => { (window as any).comparisons++; return compare(a, b); });
        }
        return cache.get(this);
      } });
    });
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`);
    await page.waitForFunction(() => Boolean((window as any).fixture));
    await page.evaluate(() => (window as any).fixture.setPanelOpen(true));
    await page.getByRole("button", { name: "Show file tree", exact: true }).click();
    await page.locator('.workspace-file-tree__row[title="/fixture/a-nested"]').waitFor();
    const initiallyMounted = await page.locator(".workspace-file-tree__row").count();
    assert.ok(initiallyMounted < 80, `5,004 entries mounted ${initiallyMounted} rows; expected a viewport-sized tree`);
    const tree = page.getByRole("tree", { name: "Workspace files" });
    const item = (name: string) => tree.getByRole("treeitem", { name, exact: true });
    await item("a-nested").waitFor();
    await page.evaluate(theme => (window as any).fixture.setThemePreference(theme), theme);
    assert.ok(await tree.getAttribute("data-row-count").then(Number) > 5000);
    assert.ok(await tree.locator(".workspace-file-tree__row").count() < 80);
    assert.equal(await page.evaluate(() => (window as any).fixtureRuntime.listeners.size), 1);
    const sorted = await page.evaluate(() => (window as any).comparisons);
    await page.evaluate(async () => { for (let i = 0; i < 20; i++) { (window as any).fixtureRuntime.tick(); (window as any).fixture.setSidebar(i % 2 === 0); await new Promise(requestAnimationFrame); } });
    assert.equal(await page.evaluate(() => (window as any).comparisons), sorted, "chat/Shell updates must not sort directory data");
    await page.evaluate(() => (window as any).fixture.setSidebar(false));
    await item("a-nested").click(); await item("child.html").waitFor();
    await item("b-error").click(); await tree.getByText("Directory unavailable").waitFor();
    await item("b-error").click();
    await item("c-late").click(); await tree.getByText("Loading…").waitFor(); await item("c-late").click();
    await page.evaluate(() => (window as any).fixtureRuntime.resolveLate());
    assert.equal(await item("late.html").count(), 0, "late results do not reopen a collapsed branch");
    await item("c-late").click(); await item("late.html").waitFor();
    assert.equal(await page.evaluate(() => (window as any).fixtureRuntime.reads.filter((path: string) => path.endsWith("c-late")).length), 1);
    await tree.focus(); await tree.press("End");
    await item("report-4999.html").waitFor();
    assert.ok(await tree.evaluate(element => element.scrollTop) > 100_000);
    await tree.press("Enter");
    await page.frameLocator("iframe").getByRole("heading", { name: "Persistent preview" }).waitFor();
    const scroll = await tree.evaluate(element => element.scrollTop);
    await page.evaluate(() => (window as any).savedPreview = document.querySelector("iframe"));
    await page.getByRole("button", { name: "Hide file tree", exact: true }).click();
    await page.getByRole("button", { name: "Show file tree", exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).savedPreview === document.querySelector("iframe")), true);
    assert.ok(Math.abs(await tree.evaluate(element => element.scrollTop) - scroll) < 2);
    const search = page.getByRole("textbox", { name: "Search workspace files" });
    await search.fill("child"); await page.getByRole("button", { name: /child.html/ }).waitFor();
    assert.equal(await tree.isVisible(), false);
    await search.fill(""); await tree.waitFor();
    assert.ok(Math.abs(await tree.evaluate(element => element.scrollTop) - scroll) < 2, "search preserves tree scroll");
    await tree.focus(); await tree.press("Home"); await tree.press("ArrowRight");
    assert.equal(await tree.getAttribute("aria-activedescendant"), await item("a-nested").getAttribute("id"));
    await tree.press("ArrowRight"); await tree.press("ArrowLeft");
    assert.equal(await item("a-nested").getAttribute("aria-expanded"), "true");
    await item("draft.ts").click(); await page.locator(".cm-editor").waitFor();
    await page.getByTitle("Edit file", { exact: true }).click();
    const editor = page.locator(".cm-content"); await editor.press("Control+End"); await editor.pressSequentially(" // unsaved");
    await page.evaluate(() => (window as any).savedEditor = document.querySelector(".cm-editor"));
    await page.getByRole("button", { name: "Hide file tree", exact: true }).click();
    await page.evaluate(() => { (window as any).fixtureRuntime.tick(); (window as any).fixture.setSidebar(true); });
    await page.evaluate(() => (window as any).fixture.setSidebar(false));
    await page.getByRole("button", { name: "Show file tree", exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).savedEditor === document.querySelector(".cm-editor")), true);
    assert.match(await editor.innerText(), /unsaved/);
    await page.screenshot({ path: join(output, `${width}-${theme}.png`) });
    await tree.focus(); await tree.press("End");
    await page.evaluate(async () => { (window as any).fixtureRuntime.shrink(); await (window as any).fixture.client.invalidateQueries({ queryKey: ["appserver-fs", "tree-fixture", "directory", "/fixture"] }); });
    await item("remaining.html").waitFor();
    assert.ok(await tree.evaluate(element => element.scrollTop) < 100);
    assert.match(await editor.innerText(), /unsaved/, "directory refresh does not replace a dirty draft");
    assert.deepEqual(errors, []);
    evidence.push({ width, theme, entries: 5004, initiallyMounted, comparisonsBeforeShellUpdates: sorted, extraShellComparisons: 0, snapshotSubscribers: 1 });
    await page.close();
  }
  await writeFile(join(output, "results.json"), JSON.stringify({ passed: true, evidence }, null, 2));
  console.log(JSON.stringify({ passed: true, evidence, output }));
} finally { await browser?.close(); await vite.close(); }
