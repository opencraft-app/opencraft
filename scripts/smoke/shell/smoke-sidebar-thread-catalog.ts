import assert from "node:assert/strict";
import { createServer } from "vite";

// Real Sidebar + shared theme/Intl, no duplicate test-only rendering.
const source = `
import React,{useState}from'react';
import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';
import{canDisplayHostThreadCatalog,canReadHostThreadCatalog}from'/apps/workbench-web/src/runtime/host-thread-catalog.ts';
import{Sidebar}from'/apps/workbench-web/src/components/sidebar.tsx';
import{UiPreferencesProvider,openWorkbenchUiPreferences}from'/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
import{SidebarLayoutStore}from'@opencraft/sidebar-layout';
import{legacyDirectServerProjectionFromHost}from'@opencraft/workbench-runtime';
import{initializeAppearanceTheme,setThemePreference}from'/apps/workbench-web/src/appearance-theme.ts';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_scope,doc)=>doc});
const preferences=await openWorkbenchUiPreferences();
const actions=[];
let snapshot={revision:0,mode:null,modes:[],hideRowBadge:false,notice:null,filter:{label:'My conversations',enabled:false}};
const listeners=new Set();
const grouping={id:'filter-fixture',getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},watch:()=>()=>{},project:()=>[],setMode:()=>{},toggleGroup:()=>{},filterThreads:refs=>snapshot.filter.enabled?refs.filter(ref=>ref.hostId==='local'):refs,setFilterEnabled:enabled=>{snapshot={...snapshot,revision:snapshot.revision+1,filter:{...snapshot.filter,enabled}};listeners.forEach(fn=>fn())}};
function row(i,remote=false){const hostId=remote?'ssh:remote':'local';return{id:'thread-'+i,title:'Task '+i,project:'workspace',status:'ready',updatedAt:Date.now()-i*1000,connectionHostId:hostId,connectionHostLabel:remote?'Remote':'Local',...legacyDirectServerProjectionFromHost({hostId,hostKind:remote?'remote-ssh':'local',label:remote?'Remote':'Local'})};}
function App(){const[filterUi,setFilterUi]=useState(false);const[epoch,setEpoch]=useState(0);const[threads,setThreads]=useState([]);const[catalogs,setCatalogs]=useState([{hostId:'ssh:remote',label:'Remote',phase:'loading'}]);const[discovery,setDiscovery]=useState(null);const[remoteAvailable,setRemoteAvailable]=useState(true);
const profile={hostId:'ssh:remote',hostKind:'remote-ssh',enabled:true,includeInSidebar:true,autoConnect:false,revision:1};
const cachedRows=[{...row(0),pinned:true},{...row(1,true),pinned:true},{...row(2,true),pinned:true},{...row(3),pinned:true}];
function connection(state,authenticated=true,phase=state==='open'?'ready':'reconnecting'){const management={available:true,authenticated,items:[{serverId:'ssh:remote',enabled:true,revision:1,state}],legacyServers:[],refreshing:false,error:null};
const admitted=canReadHostThreadCatalog(profile,phase,management);
setRemoteAvailable(phase==='ready'&&admitted);
setThreads(cachedRows.filter(r=>r.connectionHostId==='local'||canDisplayHostThreadCatalog(profile,management))
 .map(r=>({...r,interactionAvailable:r.connectionHostId==='local'||(phase==='ready'&&admitted)})));
return admitted;}
window.fixture={setFilterUi,resetList:()=>setEpoch(v=>v+1),grouping,setThreads,setCatalogs,setDiscovery,row,actions,setThemePreference,connection};
const threadActions={onRename:async()=>{},onFork:async()=>{},onArchive:async()=>{},onDelete:async()=>{},onSetPinned:async(target,pinned)=>{actions.push({pin:target.threadId,pinned});setThreads(rows=>rows.map(row=>row.id===target.threadId&&row.connectionHostId===target.hostId?{...row,pinned}:row));}};
return <div className={location.search.includes('mobile-layout')?'shell-sidebar__column':undefined} data-navigation-layout={location.search.includes('mobile-layout')?'mobile':undefined} style={{height:'100vh',width:300,display:'flex',flexDirection:'column'}}><Sidebar key={epoch} threadListGrouping={filterUi?grouping:null} threads={threads} activeHostId='local' activeThreadId='thread-0' sidebarLayout={layout} threadActions={threadActions} threadCapabilities={hostId=>({pin:hostId==='ssh:remote'&&remoteAvailable,rename:false,archive:false,fork:false,delete:false})} threadCatalogs={catalogs} threadCatalogDiscovery={discovery} onRetryThreadCatalogDiscovery={()=>{actions.push('discovery-read');setDiscovery('loading');}} onRetryThreadCatalog={id=>{actions.push(id);setCatalogs([{hostId:id,label:'Remote',phase:'loading'}]);}} onSelectThread={(hostId,id)=>actions.push({hostId,id})} onNewTask={()=>{}} onOpenSettings={()=>{}} /></div>;}
createIntlTestRoot(document.getElementById('root')).render(<UiPreferencesProvider runtime={preferences}><App/></UiPreferencesProvider>);`;
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-sidebar-catalog", esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "sidebar-catalog-fixture",
    resolveId: id => id === "/catalog-probe.tsx" ? id : null,
    load: id => id === "/catalog-probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url?.split("?")[0] !== "/") return next();
      res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/catalog-probe.tsx"></script>');
    }); },
  }],
});
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
let browser: any;
const evidence: unknown[] = [];
// Focus this interaction contract independently of the catalog/error/pagination suite.
async function verifyGroupDisclosures(page: any, touch: boolean, mobileLayout = touch) {
  assert.equal(await page.locator('.sidebar-thread-group-count').count(), 0, 'group headings omit thread counts');
  for (const name of ['Pinned', 'Recent']) {
    const section = page.getByRole('region', { name, exact: true });
    const toggle = section.getByRole('button', { name, exact: true });
    const arrow = toggle.locator('> svg');
    await toggle.waitFor();
    const geometry = () => toggle.evaluate((button: HTMLElement) => {
      const label = button.querySelector('.sidebar-thread-group-label')!.getBoundingClientRect();
      const glyph = button.querySelector(':scope > svg')!.getBoundingClientRect();
      return { labelEnd: label.right, arrowStart: glyph.left, buttonHeight: button.getBoundingClientRect().height };
    });
    const resting = await geometry();
    assert.ok(resting.arrowStart - resting.labelEnd >= 4 && resting.arrowStart - resting.labelEnd <= 10, 'disclosure stays beside label');
    const waitArrow = async (opacity: string) => page.waitForFunction(
      ({ arrow, opacity }: any) => getComputedStyle(arrow).opacity === opacity,
      { arrow: await arrow.elementHandle(), opacity }, { timeout: 3000 });
    if (mobileLayout) {
      await waitArrow('1');
      assert.ok(resting.buttonHeight >= 44, 'touch disclosure has a full row hit target');
      if (touch) await toggle.tap(); else await toggle.click();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      await waitArrow('1');
      if (touch) await toggle.tap(); else await toggle.click();
    } else {
      await page.mouse.move(700, 800);
      await page.locator('.sidebar-list-mode-trigger').focus();
      await waitArrow('0');
      await toggle.hover();
      await waitArrow('1');
      assert.deepEqual(await geometry(), resting, 'revealing arrow does not shift label or row');
      await page.mouse.move(700, 800);
      await waitArrow('0');
      await page.keyboard.press('Tab');
      await toggle.focus();
      await waitArrow('1');
      await page.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      await page.keyboard.press('Space');
    }
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'same disclosure restores expanded content');
    assert.equal(await section.locator('.sidebar-activity-group__items').isVisible(), true);
  }
}
try {
  await vite.listen();
  const origin = vite.resolvedUrls!.local[0]!;
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const scenarios = [{ touch: false, mobileLayout: false }, { touch: true, mobileLayout: true }];
  if (process.env.OPENCRAFT_SIDEBAR_GROUPS_ONLY === '1') scenarios.push({ touch: false, mobileLayout: true });
  for (const { touch, mobileLayout } of scenarios) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : mobileLayout ? 600 : 900, height: 844 }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(origin + (mobileLayout && process.env.OPENCRAFT_SIDEBAR_GROUPS_ONLY === '1' ? '?mobile-layout' : ''), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean((window as any).fixture && document.querySelector('.sidebar-tasks')), null, { timeout: 60000 });
    await page.locator('.sidebar-tasks[aria-busy="true"]').waitFor({ state: "attached" });
    await page.evaluate(theme => (window as any).fixture.setThemePreference(theme), theme);
    if (process.env.OPENCRAFT_SIDEBAR_GROUPS_ONLY === '1') {
      await page.evaluate(() => {
        const f = (window as any).fixture;
        f.setThreads([{ ...f.row(0), pinned: true }, f.row(1)]);
        f.setCatalogs([]);
      });
      await verifyGroupDisclosures(page, touch, mobileLayout);
      assert.deepEqual(errors, []);
      if (process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR}/groups-${touch ? 'touch' : mobileLayout ? 'mobile-mouse' : 'desktop'}-${theme}.png` });
      evidence.push({ touch, mobileLayout, theme, groupDisclosures: true, hiddenDesktop: !mobileLayout, alwaysVisibleMobile: mobileLayout, stableGeometry: true, reversibleCollapse: true });
      await context.close();
      continue;
    }
    // Radix restores focus after closing: open, restored and keyboard focus
    // must retain the filled treatment rather than the old standalone ring.
    const filterTrigger = page.locator(".sidebar-list-mode-trigger");
    const assertFilledFocus = async () => {
      const state = await filterTrigger.evaluate(el => {
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--color-background-button-primary)";
        document.body.append(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const style = getComputedStyle(el);
        return { background: style.backgroundColor, expected, outline: style.outlineStyle, foreground: style.color };
      });
      assert.equal(state.background, state.expected, "open/focused filter uses shared primary fill, including hover");
      assert.equal(state.outline, "none", "filter has no standalone outline");
      assert.notEqual(state.foreground, state.background, "filter glyph contrasts with fill");
    };
    if (touch) await filterTrigger.tap(); else await filterTrigger.click();
    await page.getByRole("menu").waitFor();
    await assertFilledFocus();
    await page.getByRole("menuitemradio").first().click();
    await page.getByRole("menu").waitFor({ state: "hidden" });
    assert.equal(await filterTrigger.evaluate(el => getComputedStyle(el).outlineStyle), "none", "pointer selection restores focus without a ring");
    await page.keyboard.press("Tab");
    await filterTrigger.focus();
    await assertFilledFocus();
    await page.keyboard.press("Enter");
    await page.getByRole("menu").waitFor();
    await page.keyboard.press("Escape");
    await assertFilledFocus();
    await page.mouse.click(350, 10);
    assert.equal(await page.locator(".sidebar-activity-empty").count(), 0, "pending is not empty");
    assert.equal(await page.locator(".sidebar-catalog-feedback").count(), 0, "loading has no feedback row or spacer");
    assert.equal(await page.locator(".sidebar-tasks .workbench-loading-spinner").count(), 0, "catalog loading has no visible spinner");
    await page.evaluate(() => {
      const f = (window as any).fixture;
      f.setThreads([f.row(0)]);
      f.setCatalogs([{ hostId: "ssh:remote", label: "Remote Server with a deliberately long directory label", phase: "error" }]);
    });
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await retry.waitFor();
    const retryBounds = await retry.boundingBox();
    const sidebarBounds = await page.locator('.sidebar-panel').boundingBox();
    assert.ok(retryBounds && sidebarBounds && retryBounds.x >= sidebarBounds.x
      && retryBounds.x + retryBounds.width <= sidebarBounds.x + sidebarBounds.width + 1,
      'Retry is fully inside the Sidebar before interaction or automatic scrolling');
    assert.equal(await page.locator(".sidebar-activity-item").count(), 1, "one failed server retains healthy rows");
    // Scheme C: directory is auxiliary text below the title, never a chip or title column.
    await page.evaluate(() => {
      const f = (window as any).fixture;
      f.setThreads([
        { ...f.row(0), title: 'A deliberately long conversation title that needs its full body width', project: 'a-very-long-working-directory-that-must-not-push-the-title', status: 'running' },
        { ...f.row(1), project: 'workspace', status: 'review' },
        { ...f.row(2), project: 'runtime', status: 'error' },
      ]);
    });
    await page.waitForFunction(() => document.querySelectorAll('.sidebar-activity-item__project').length === 3);
    const geometry = await page.locator('.sidebar-activity-item').evaluateAll(items => items.map(item => {
      const title = item.querySelector<HTMLElement>('.sidebar-activity-item__title')!;
      const project = item.querySelector<HTMLElement>('.sidebar-activity-item__project')!;
      const body = item.querySelector<HTMLElement>('.sidebar-activity-item__body')!;
      const style = getComputedStyle(project);
      return { title: title.textContent, titleBottom: title.getBoundingClientRect().bottom, projectTop: project.getBoundingClientRect().top,
        projectRight: project.getBoundingClientRect().right, bodyRight: body.getBoundingClientRect().right,
        background: style.backgroundColor, directoryColor: style.color,
        titleColor: getComputedStyle(title).color, truncated: project.scrollWidth > project.clientWidth,
        height: item.getBoundingClientRect().height };
    }));
    assert.ok(geometry.every(row => row.projectTop >= row.titleBottom), 'directory occupies the second line');
    assert.ok(geometry.every(row => row.background === 'rgba(0, 0, 0, 0)'), 'directory has no chip surface, including selected row');
    assert.ok(geometry.every(row => row.directoryColor !== row.titleColor), 'directory uses auxiliary text color');
    assert.ok(geometry.every(row => row.projectRight <= row.bodyRight + 1), 'directory stays within title body');
    assert.ok(geometry.find(row => row.title === 'A deliberately long conversation title that needs its full body width')!.truncated, 'long directory truncates without consuming title width');
    assert.ok(geometry.every(row => row.height >= 48), 'two-line rows preserve readable height');
    assert.equal(await page.locator('.sidebar-activity-item__state-label').filter({ hasText: 'Running' }).count(), 0, 'no redundant running text');
    if (process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR}/project-secondary-${touch ? 'touch' : 'desktop'}-${theme}.png` });
    await page.evaluate(() => { const f = (window as any).fixture; f.setThreads([f.row(0)]); });
    await page.waitForFunction(() => document.querySelectorAll('.sidebar-activity-item').length === 1);
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
    await page.evaluate(()=>{const f=(window as any).fixture;f.setCatalogs([]);f.setFilterUi(true);f.grouping.setFilterEnabled(true);f.setThreads([...Array.from({length:8},(_,i)=>f.row(i)),...Array.from({length:39},(_,i)=>f.row(100+i,true))]);});
    await page.waitForFunction(()=>document.querySelectorAll('.sidebar-activity-item').length===8);
    assert.equal(await page.locator('.sidebar-activity-more').count(),0,'filtered-out conversations do not create bottom prompts');
    await page.evaluate(()=>{const f=(window as any).fixture;f.setThreads([...Array.from({length:12},(_,i)=>f.row(i)),...Array.from({length:39},(_,i)=>f.row(100+i,true))]);});
    const filteredMore=page.getByRole('button',{name:'Load more',exact:true});await filteredMore.waitFor();
    assert.equal(await page.locator('.sidebar-activity-more').count(),1,'only the matching recent display budget creates Load more');
    await filteredMore.click();
    await page.waitForFunction(()=>document.querySelectorAll('.sidebar-activity-item').length===12);
    assert.equal(await page.locator('.sidebar-activity-more').count(),0,'no redundant collapse/show-all footer after loading');
    assert.equal(await page.locator('.sidebar-list-chips').count(),0,'participation and server chips are consolidated');
    await page.getByRole('button',{name:'Filters',exact:true}).click();
    assert.equal(await page.getByRole('menuitemradio',{name:'All servers',exact:true}).getAttribute('aria-checked'),'true');
    if (process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR) await page.getByRole('menu').screenshot({path:process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR+'/filters-'+(touch?'touch':'desktop')+'-'+theme+'.png'});
    assert.equal(await page.getByRole('menuitemcheckbox',{name:'Only my conversations',exact:true}).getAttribute('aria-checked'),'true','loading never disables the personal filter');
    await page.getByRole('menuitemcheckbox',{name:'Only my conversations',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.sidebar-activity-item').length===51);
    assert.equal(await page.locator('.sidebar-activity-more').count(),0);
    await page.evaluate(()=>{(window as any).fixture.setFilterUi(false);(window as any).fixture.resetList();});
    await page.evaluate(() => {
      const f = (window as any).fixture;
      f.setDiscovery(null);
      f.setThreads(Array.from({ length: 13 }, (_, i) => f.row(i, i >= 10)));
      f.setCatalogs([{ hostId: "ssh:remote", label: "Remote", phase: "ready" }]);
    });
    const more = page.getByRole("button", { name: "Load more", exact: true });
    await more.waitFor();
    assert.equal(await page.locator(".sidebar-activity-item").count(), 10);
    if (process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR}/catalog-more-${touch ? "touch" : "desktop"}-${theme}.png` });
    if (touch) await more.tap(); else await more.click();
    await more.waitFor({state:"detached"});
    assert.equal(await page.locator(".sidebar-activity-item").count(), 13);
    assert.equal(await page.locator(".sidebar-catalog-feedback").count(), 0);
    await page.evaluate(()=>{(window as any).fixture.setFilterUi(false);(window as any).fixture.resetList();});
    await page.evaluate(() => {
      const f = (window as any).fixture;
      f.setThreads([...Array.from({ length: 13 }, (_, i) => f.row(i, i >= 10)), { ...f.row(100, true), pinned: true }]);
    });
    const pinnedSection = page.getByRole("region", { name: "Pinned", exact: true });
    await pinnedSection.waitFor();
    assert.equal(await pinnedSection.locator(".sidebar-activity-item").count(), 1);
    await verifyGroupDisclosures(page, touch);

    assert.equal(await page.locator(".sidebar-activity-item").count(), 11, "pins do not consume ten recent slots");
    assert.equal(await page.getByRole("button", { name: "Actions for Task 0", exact: true }).count(), 0, "unsupported host hides the operation trigger");
    const trigger = page.getByRole("button", { name: "Actions for Task 100", exact: true });
    if (!touch) await pinnedSection.locator(".sidebar-activity-row").hover();
    if (touch) await trigger.tap(); else await trigger.click();
    const unpin = page.getByRole("menuitem", { name: "Unpin", exact: true });
    await unpin.waitFor();
    if (touch) await unpin.tap(); else await unpin.click();
    await pinnedSection.waitFor({ state: "detached" });
    assert.equal(await page.locator(".sidebar-activity-item").count(), 10);
    assert.equal(await page.evaluate(() => (window as any).fixture.actions.at(-1).pinned), false);
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    if (!touch) await page.locator(".sidebar-activity-row").filter({ has: page.getByRole("button", { name: "Actions for Task 100", exact: true }) }).hover();
    await page.getByRole("button", { name: "Actions for Task 100", exact: true }).click();
    await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
    await pinnedSection.waitFor();
    assert.equal(await pinnedSection.locator(".sidebar-activity-item").count(), 1, "pin appears once after acknowledgement");
    assert.equal(await page.locator(".sidebar-activity-item").count(), 14);
    await page.evaluate(() => (window as any).fixture.connection('open'));
    await page.getByText('Task 3', { exact: true }).waitFor();
    const before = await page.locator('.sidebar-activity-item').evaluateAll(rows => rows.map(row => ({text: row.textContent, y: row.getBoundingClientRect().y})));
    await page.evaluate(() => { (window as any).retainedRows = [...document.querySelectorAll('.sidebar-activity-item')]; });
    for (const state of ['connecting', 'open', 'idle', 'open', 'error', 'open', 'connecting', 'open']) {
      const admitted = await page.evaluate(state => (window as any).fixture.connection(state), state);
      assert.equal(admitted, state === 'open', 'displaying cached rows cannot authorize offline reads');
      await page.waitForTimeout(30);
      assert.deepEqual(await page.locator('.sidebar-activity-item').evaluateAll(rows => rows.map(row => ({text: row.textContent, y: row.getBoundingClientRect().y}))), before, 'transport transitions cannot remove/reorder cached rows');
      assert.equal(await page.evaluate(() => (window as any).retainedRows.every((row, index) => row === document.querySelectorAll('.sidebar-activity-item')[index])), true, 'reconnect preserves actual row nodes');
    }
    await page.evaluate(() => (window as any).fixture.connection('open', false));
    await page.waitForTimeout(30);
    assert.equal(await page.locator('.sidebar-activity-item').count(), 2, 'authorization revocation clears remote cache while local rows remain');
    await page.evaluate("window.fixture.setThreads([{...window.fixture.row(201),status:'review'},{...window.fixture.row(202),status:'error'},{...window.fixture.row(203),unread:true},{...window.fixture.row(204),unread:true,pinned:true}])");
    const attention = page.getByRole("region", { name: "Needs your attention", exact: true });
    await attention.getByText("Task 201", { exact: true }).waitFor();
    assert.equal(await attention.locator('.sidebar-activity-item').count(), 2);
    assert.equal(await attention.getByText("Task 202", { exact: true }).count(), 1);
    assert.equal(await attention.getByText("Task 203", { exact: true }).count(), 0, "unread replies never become todos");
    assert.equal(await pinnedSection.getByText("Task 204", { exact: true }).count(), 1, "unread keeps pinned placement");
    assert.equal(await page.getByText("Task 203", { exact: true }).count(), 1, "unread reply remains reachable");
    await page.evaluate(() => (window as any).fixture.setThreads([]));
    await page.locator(".sidebar-activity-empty").waitFor();
    await page.evaluate(() => (window as any).fixture.connection('open'));
    const serverFilter = page.getByRole('button', { name: 'Filters', exact: true });
    await serverFilter.click();
    await page.getByRole('menuitemradio', { name: 'Remote', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.sidebar-activity-item').length === 2);
    await page.evaluate(() => { (window as any).filteredRows = [...document.querySelectorAll('.sidebar-activity-item')]; });
    for (const state of ['idle', 'open', 'error', 'open']) {
      await page.evaluate(state => (window as any).fixture.connection(state), state);
      await page.waitForFunction(online => [...document.querySelectorAll<HTMLButtonElement>('.sidebar-activity-item')].every(row => row.disabled === !online), state === 'open');
      assert.equal(await page.evaluate(() => (window as any).filteredRows.every((row, i) => row === document.querySelectorAll('.sidebar-activity-item')[i])), true, 'offline keeps filtered row identity');
      assert.ok((await serverFilter.getAttribute('title'))?.includes('Remote'));
    }
    assert.equal(await page.evaluate(() => (window as any).fixture.connection('open', true, 'reconnecting')), false, 'stale backend open cannot bypass logical reconnect');
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>('.sidebar-activity-item')].every(row => row.disabled));
    const actionsBeforeOfflineClick = await page.evaluate(() => (window as any).fixture.actions.length);
    await page.locator('.sidebar-activity-item').first().evaluate((row: HTMLButtonElement) => row.click());
    assert.equal(await page.evaluate(() => (window as any).fixture.actions.length), actionsBeforeOfflineClick, 'offline row cannot invoke conversation navigation');
    if (process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR}/filtered-offline-${touch ? 'touch' : 'desktop'}-${theme}.png` });
    await page.reload();
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Remote', exact: true }).waitFor();
    assert.equal(await page.getByRole('menuitemradio', { name: 'Remote', exact: true }).getAttribute('aria-checked'),'true');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { const f = (window as any).fixture; f.setThreads([f.row(0)]); });
    await page.waitForTimeout(30);
    assert.equal(await page.locator('.sidebar-activity-item').count(), 0, 'restored filter never falls back to unrelated local rows during remote loading');
    await page.evaluate(() => (window as any).fixture.connection('open'));
    await page.waitForFunction(() => document.querySelectorAll('.sidebar-activity-item').length === 2);
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'All servers', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.sidebar-activity-item').length === 4);
    // A successful Hub response may contain a saved directory after refresh failed.
    // Transport success must not hide the failure or its Host-scoped retry.
    const cachedMessage = page.getByText("Showing saved Remote conversations; refresh failed", { exact: true });
    const rowsBeforeCachedRetry = await page.locator('.sidebar-activity-item').elementHandles();
    const actionsBeforeCachedRetry = await page.evaluate(() => (window as any).fixture.actions.slice());
    for (const catalog of [{ phase: 'ready', cachedAt: 0 }, { phase: 'error', cachedAt: 123 }]) {
      await page.evaluate(catalog => (window as any).fixture.setCatalogs([{ hostId: 'ssh:remote', label: 'Remote', ...catalog }]), catalog);
      await cachedMessage.waitFor();
      assert.equal(await page.getByRole('button', { name: 'Retry', exact: true }).count(), 1);
      assert.equal(await page.locator('.sidebar-activity-item').count(), 4, 'saved directory failure keeps existing rows');
      if (touch) await retry.tap(); else await retry.click();
      await page.locator('.sidebar-tasks[aria-busy="true"]').waitFor({ state: 'attached' });
      assert.equal(await page.locator('.sidebar-catalog-feedback').count(), 0, 'cached retry remains visually quiet');
      for (const [index, row] of rowsBeforeCachedRetry.entries()) assert.equal(await row.evaluate((row, index) => row === document.querySelectorAll('.sidebar-activity-item')[index], index), true, 'cached retry preserves row identity');
    }
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.actions), [...actionsBeforeCachedRetry, 'ssh:remote', 'ssh:remote'], 'saved-directory retries only read their exact Host');
    await page.evaluate(() => (window as any).fixture.setCatalogs([{ hostId: 'ssh:remote', label: 'Remote', phase: 'loading', cachedAt: 123 }]));
    await page.locator('.sidebar-tasks[aria-busy="true"]').waitFor({ state: 'attached' });
    assert.equal(await page.locator('.sidebar-catalog-feedback').count(), 0, 'in-flight cached refresh adds no feedback row');
    await page.evaluate(() => (window as any).fixture.setCatalogs([{ hostId: 'ssh:remote', label: 'Remote', phase: 'ready' }]));
    await page.locator('.sidebar-tasks[aria-busy="false"]').waitFor({ state: 'attached' });
    assert.equal(await page.locator('.sidebar-catalog-feedback').count(), 0, 'successful refresh removes cached failure');
    assert.deepEqual(errors, []);
    evidence.push({ touch, theme, reducedMotion: true, quietLoading: true, savedDirectoryFailureRetry: true, loadingNotEmpty: true, stableHistoryGeometry: true, failedHostIsolation: true, scopedRetry: true, discoveryRetryWithoutProfiles: true, matchingResultsOnly: true, filteredRowsHaveNoFooter: true, loadMorePreservesFilters: true, serverFilterSurvivesReload: true, missingFilteredServerNeverBroadens: true, offlineControlsDisabled: true, capabilityLossPreservesRows: true, successfulEmpty: true, cachedRowsStableThroughReconnect: true, revokedCacheHidden: true, nativePinPresentation: true, unsupportedPinHidden: true, pinDoesNotConsumeRecentBudget: true });
    await context.close();
  }
  console.log(JSON.stringify({ ok: true, realSidebar: true, evidence }));
} finally { await browser?.close(); await vite.close(); }
