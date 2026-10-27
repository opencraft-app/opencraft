import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const output = await mkdtemp(join(tmpdir(), 'opencraft-sidebar-browser-resources-'));
const source = `
import React from 'react';import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';
import{Sidebar}from'/apps/workbench-web/src/components/sidebar.tsx';import{SidebarLayoutStore}from'@opencraft/sidebar-layout';
import{createConversationBindingStore,legacyDirectServerProjectionFromHost}from'@opencraft/workbench-runtime';import{createConversationKey}from'@opencraft/chat-core';
import{BrowserWorkbenchCoordinator}from'/apps/workbench-web/src/browser/browser-workbench-coordinator.ts';import{BrowserEnvironmentProvider}from'/apps/workbench-web/src/browser/browser-runtime-context.tsx';
import{UiPreferencesProvider,openWorkbenchUiPreferences}from'/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
import{initializeAppearanceTheme,setThemePreference,setAppearanceThemeId}from'/apps/workbench-web/src/appearance-theme.ts';import'/apps/workbench-web/src/styles/app.scss';initializeAppearanceTheme();
const values=new Map(),listeners=new Map();let created=0,prepared=0;const closed=[],opened=[],selected=[];
const pages={setNewWindowHandler(){},openExternalIfRequired:()=>false,create({ownerId}){const id='page-'+(++created);values.set(id,{id,ownerId,title:created===1?'Example Alpha':created===2?'Long title that remains readable in a narrow resource menu and does not overflow':'Example Beta',navigation:{currentUrl:'https://example.com/'+created}});return id},getSnapshot:id=>values.get(id)??null,list:()=>[...values.values()],subscribe(id,l){const set=listeners.get(id)??new Set();set.add(l);listeners.set(id,set);return()=>set.delete(l)},prepareSurface(){prepared++;throw Error('Resource directory woke a page')},close(id){closed.push(id);values.delete(id)}};
const bindings=createConversationBindingStore();for(const h of ['a','b'])bindings.bind('scope-'+h,createConversationKey('host-'+h,'same'));
const panels={open(owner,_kind,{browserTabId}){opened.push({owner,browserTabId});return{id:'panel'}},close(){},dispatch(){},ensureOwner(){}};
const workbench=new BrowserWorkbenchCoordinator(pages,panels,bindings,{getItem:()=>null,setItem(){}});
workbench.open('scope-a');workbench.open('scope-a');workbench.open('scope-b');opened.length=0;
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_s,d)=>d}),preferences=await openWorkbenchUiPreferences();
window.fixture={setThemePreference,setAppearanceThemeId,workbench,get state(){return{created,prepared,closed,opened,selected}},rename(){const page=values.get('page-1');values.set('page-1',{...page,title:'Updated Alpha'});for(const l of listeners.get('page-1')??[])l()}};
const threads=['empty','a','b'].map(h=>({id:'same',title:h==='a'?'Alpha conversation':h==='b'?'Beta conversation':'No browser conversation',project:'Workspace',status:h==='a'?'running':'ready',pinned:true,updatedAt:Date.now()/1000,connectionHostId:'host-'+h,connectionHostLabel:'Host '+h,...legacyDirectServerProjectionFromHost({hostId:'host-'+h,hostKind:'local',label:'Host '+h})}));
const metadata=new URLSearchParams(location.search).get('badge')==='metadata';
createIntlTestRoot(document.getElementById('root')).render(<UiPreferencesProvider runtime={preferences}><BrowserEnvironmentProvider workbench={workbench} pages={pages} surfaces={{}} presentations={{}}><div style={{width:'min(320px,100vw)',height:'100vh',display:'flex',flexDirection:'column'}}><Sidebar threads={threads} activeHostId='host-a' activeThreadId='same' sidebarLayout={layout} threadBadge={{placement:metadata?'metadata':'trailing',Component:()=> <span aria-label='Participant' style={{display:'inline-flex',alignItems:'center',minWidth:24,height:24}}>A</span>}} threadActions={{onRename:async()=>{},onFork:async()=>{},onArchive:async()=>{},onDelete:async()=>{},onSetPinned:async()=>{}}} threadCapabilities={()=>({pin:true,rename:false,fork:false,archive:false,delete:false})} onSelectThread={(host,id)=>selected.push({host,id})} onNewTask={()=>{}} onOpenSettings={()=>{}} showFooter={false}/></div></BrowserEnvironmentProvider></UiPreferencesProvider>);
`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', resolve: { dedupe: ['react', 'react-dom'] }, cacheDir: 'node_modules/.vite-browser-resources', esbuild: { jsx: 'automatic', target: 'esnext' }, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'fixture', resolveId: id => id === '/fixture.tsx' ? id : null, load: id => id === '/fixture.tsx' ? source : null, configureServer(server) { server.middlewares.use((req, res, next) => { if (!req.url?.startsWith('/?') && req.url !== '/') return next(); res.setHeader('content-type', 'text/html'); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>'); }); } }] });
let browser;
const results: unknown[] = [];
try {
  await vite.listen(); browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
  for (const touch of [false, true]) for (const theme of ['light', 'dark']) for (const badge of ['trailing', 'metadata']) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1200, height: 900 }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage(), errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); await page.addInitScript('window.__name=value=>value;');
    try {
      await page.goto(vite.resolvedUrls!.local[0]! + '?badge=' + badge); await page.waitForFunction(() => (window as any).fixture, undefined, { timeout: 60000 });
      await page.evaluate(({ touch, theme }) => { (window as any).fixture.setThemePreference(theme); document.documentElement.dataset.uiDensity = touch ? 'touch' : 'compact'; if (touch) document.documentElement.dataset.touchInteraction = 'true'; }, { touch, theme });
      const a = page.getByRole('button', { name: '2 browser tabs', exact: true }), b = page.getByRole('button', { name: '1 browser tab', exact: true }); await a.waitFor();
      assert.equal(await b.isVisible(), true);
      const geometry = await page.locator('.sidebar-activity-item-container').evaluateAll(rows => rows.map(row => { const rect = (selector: string) => row.querySelector(selector)!.getBoundingClientRect().toJSON(); return { width: row.clientWidth, scroll: row.scrollWidth, title: rect('.sidebar-activity-item__title'), resources: row.querySelector('.sidebar-browser-resources') ? rect('.sidebar-browser-resources') : null, participant: rect('.sidebar-activity-item__badge-slot') }; }));
      for (const g of geometry) { assert(g.scroll <= g.width + 1); assert(g.title.width > 40); if (g.resources && badge === 'trailing') assert(g.resources.x >= g.participant.right - 1, 'resource and participant have separate tracks'); }
      const invoke = async (target: any) => { if (touch) await target.tap(); else await target.click(); };
      await invoke(a); await page.getByRole('menuitem', { name: 'Example Alpha', exact: true }).waitFor();
      assert.equal((await page.evaluate(() => (window as any).fixture.state)).prepared, 0);
      assert.equal((await page.evaluate(() => (window as any).fixture.state)).selected.length, 0, 'opening a menu must not navigate');
      await page.evaluate(() => (window as any).fixture.rename()); await page.getByRole('menuitem', { name: 'Updated Alpha', exact: true }).waitFor();
      await page.screenshot({ path: join(output, `${theme}-${touch ? 'touch' : 'mouse'}-${badge}.png`) });
      await invoke(page.getByRole('menuitem', { name: 'Updated Alpha', exact: true }));
      const state = await page.evaluate(() => (window as any).fixture.state); assert.equal(state.created, 3); assert.equal(state.prepared, 0); assert.deepEqual(state.selected, [{ host: 'host-a', id: 'same' }]); assert.equal(state.opened[0].owner, 'scope-a');
      await invoke(b); await page.getByRole('menuitem', { name: 'Example Beta', exact: true }).waitFor(); await invoke(a); await page.getByRole('menuitem', { name: 'Updated Alpha', exact: true }).waitFor(); assert.equal(await page.getByRole('menuitem', { name: 'Example Beta', exact: true }).count(), 0);
      const actions = page.getByRole('button', { name: 'Actions for No browser conversation', exact: true }); await actions.focus(); await actions.press('Enter'); await page.getByRole('menuitem', { name: 'Unpin', exact: true }).waitFor(); assert.equal(await page.getByRole('menuitem', { name: 'Updated Alpha', exact: true }).count(), 0); await page.keyboard.press('Escape');
      await invoke(b); await invoke(page.getByRole('menuitem', { name: 'Close all browser tabs', exact: true })); await b.waitFor({ state: 'detached' }); assert.equal(await a.isVisible(), true);
      await invoke(a); await invoke(page.getByRole('menuitem', { name: 'Close all browser tabs', exact: true })); await a.waitFor({ state: 'detached' });
      const end = await page.evaluate(() => (window as any).fixture.state); assert.equal(end.closed.length, 3); assert.equal(end.prepared, 0); assert.equal(await page.getByRole('menu').count(), 0); assert.deepEqual(errors, []);
      results.push({ touch, theme, badge, geometry, passed: true });
    } catch (error) { await page.screenshot({ path: join(output, 'failure.png') }); console.error(JSON.stringify({ output, errors })); throw error; } finally { await context.close(); }
  }
  await writeFile(join(output, 'result.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify({ passed: true, output, scenarios: results.length }));
} finally { await browser?.close(); await vite.close(); }
