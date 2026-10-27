import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";

const output = process.env.OPENCRAFT_MENU_LATENCY_OUTPUT ?? "/tmp/opencraft-sidebar-menu-latency";
const sampleCount = Number(process.env.OPENCRAFT_PERFORMANCE_SAMPLES ?? 3);
assert.ok(Number.isSafeInteger(sampleCount) && sampleCount >= 3 && sampleCount <= 100);
const source = `
import React,{useState} from 'react';
import * as Popover from '@radix-ui/react-popover';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {Sidebar} from '/apps/workbench-web/src/components/sidebar.tsx';
import {SidebarLayoutStore} from '@opencraft/sidebar-layout';
import {legacyDirectServerProjectionFromHost} from '@opencraft/workbench-runtime';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async()=>{}});
const count=Number(new URL(location.href).searchParams.get('rows')||200);
const initial=Array.from({length:count},(_,i)=>({id:'t'+i,title:'Conversation '+i,project:'workspace',status:'ready',updatedAt:Date.now()/1000-i,connectionHostId:'local',connectionHostLabel:'Local',...legacyDirectServerProjectionFromHost({hostId:'local',hostKind:'local',label:'Local'})}));
let snapshot={revision:0,mode:'creator',modes:[{id:'creator',label:'By creator'}],hideRowBadge:false,notice:null};
const listeners=new Set();const publish=patch=>{snapshot={...snapshot,...patch,revision:snapshot.revision+1};for(const listener of listeners)listener()};
let groupAvatar=null,groupCollapsed=false;
const grouping={id:'probe',getSnapshot:()=>snapshot,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},watch:()=>()=>{},project:refs=>{window.projections++;return[{id:'all',label:'All conversations',avatarUrl:groupAvatar,collapsed:groupCollapsed,threads:refs}]},setMode:mode=>publish({mode}),toggleGroup:()=>{groupCollapsed=!groupCollapsed;publish({})}};
// Synthetic badge content; the controlled plugin contract and Radix popover are real.
const badge={id:'probe',placement:new URL(location.href).searchParams.has('title')?'title':undefined,Component:({threadId,open,onOpenChange,onCloseAutoFocus,portalContainer})=><Popover.Root open={open} onOpenChange={onOpenChange}><Popover.Trigger asChild><button aria-label={'People '+threadId}>People</button></Popover.Trigger><Popover.Portal container={portalContainer}><Popover.Content onCloseAutoFocus={onCloseAutoFocus}>Participants {threadId}</Popover.Content></Popover.Portal></Popover.Root>};
window.rowsProcessed=0;window.projections=0;window.actions=[];
const actions={onRename:async()=>{},onFork:async()=>{},onArchive:async()=>window.actions.push('archive'),onDelete:async()=>{},onSetPinned:async()=>window.actions.push('pin')};
const capabilities=()=>({pin:true,rename:true,fork:true,archive:true,delete:true});
function App(){const[rows,setRows]=useState(initial);const[active,setActive]=useState('t0');window.fixture={setRows,setActive,initial,setThemePreference,setMode:grouping.setMode,setGroupAvatar:value=>{groupAvatar=value;publish({})}};return <div style={{width:320,height:800,display:'flex'}}><Sidebar threads={rows} activeHostId='local' activeThreadId={active} sidebarLayout={layout} threadActions={actions} threadBadge={badge} threadListGrouping={grouping} threadCapabilities={capabilities} pendingTitle={()=>{window.rowsProcessed++;return undefined}} onSelectThread={(_,id)=>setActive(id)} onNewTask={()=>{}} onOpenSettings={()=>{}} showFooter={false}/></div>}
createIntlTestRoot(document.getElementById('root')).render(<App/>);`;

const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-sidebar-menu-latency",
  optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "@radix-ui/react-context-menu", "@radix-ui/react-dropdown-menu", "@radix-ui/react-popover", "@tanstack/react-query", "hoist-non-react-statics", "react-is", "scheduler"] },
  esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{
    name: "sidebar-menu-latency-fixture",
    resolveId: id => id === "/fixture.tsx" ? id : null,
    load: id => id === "/fixture.tsx" ? source : null,
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/?")) return next();
        res.setHeader("content-type", "text/html");
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>');
      });
    },
  }],
});
let browser: any;
const evidence: unknown[] = [];
try {
  await mkdir(output, { recursive: true });
  await vite.listen();
  const pw = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
  browser = await pw.chromium.launch({ headless: true, args: process.env.OPENCRAFT_CHROMIUM_NO_SANDBOX === "1" ? ["--no-sandbox"] : [], executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const rows of [30, 200]) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 844 } });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript("window.__name=v=>v");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/?rows=${rows}`);
    await page.locator(".sidebar-activity-item").first().waitFor();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const samples = [];
    for (let i = 0; i < sampleCount; i++) {
      const sample = await page.evaluate(async () => {
        const w = window as any;
        const before = { rows: w.rowsProcessed, projections: w.projections };
        const start = performance.now();
        document.querySelector(".sidebar-activity-item")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 200, button: 2 }));
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Menu did not open")), 10_000);
          const check = () => document.querySelector('[role="menu"]') ? requestAnimationFrame(() => { clearTimeout(timeout); resolve(); }) : requestAnimationFrame(check);
          check();
        });
        return { ms: performance.now() - start, rowsProcessed: w.rowsProcessed - before.rows, projections: w.projections - before.projections };
      });
      assert.equal(sample.rowsProcessed, 0, "opening a row menu must not reconstruct the list");
      assert.equal(sample.projections, 0, "opening a row menu must not rerun product grouping");
      samples.push(sample);
      assert.equal(await page.getByRole("menu").count(), 1);
      assert.equal(await page.getByRole("menuitem", { name: "Archive", exact: true }).locator("svg").count(), 1);
      await page.keyboard.press("Escape");
      await page.getByRole("menu").waitFor({ state: "hidden" });
    }
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    // Real keyboard activation of More preserves one controlled menu and row DOM.
    await page.evaluate(() => { (window as any).rowNode = document.querySelector(".sidebar-activity-item"); });
    const more = page.getByRole("button", { name: "Actions for Conversation 0", exact: true });
    await more.focus(); await more.press("Enter");
    await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).actions), ["pin"]);
    assert.equal(await page.evaluate(() => (window as any).rowNode === document.querySelector(".sidebar-activity-item")), true);
    // Badge and row actions participate in the same owner, including late closes.
    await page.getByRole("button", { name: "People t0", exact: true }).click();
    await page.getByText("Participants t0", { exact: true }).waitFor();
    await page.locator(".sidebar-activity-item").nth(1).dispatchEvent("contextmenu", { clientX: 120, clientY: 240, button: 2 });
    await page.getByRole("menu").waitFor();
    await page.getByText("Participants t0", { exact: true }).waitFor({ state: "hidden" });
    await page.evaluate(() => (window as any).fixture.setActive("t2"));
    await page.getByRole("menu").waitFor({ state: "hidden" });
    // Navigation can change selection without an outside pointer event (Browser POP).
    // Opening the list filter itself must retain the isolated menu-update cost.
    const beforeFilter = await page.evaluate(() => ({ rows: (window as any).rowsProcessed, projections: (window as any).projections }));
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByRole("menu").waitFor();
    assert.deepEqual(await page.evaluate(() => ({ rows: (window as any).rowsProcessed, projections: (window as any).projections })), beforeFilter);
    await page.evaluate(() => (window as any).fixture.setActive("t1"));
    await page.getByRole("menu").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByRole("menu").waitFor();
    await page.evaluate(() => (window as any).fixture.setRows((window as any).fixture.initial.slice(1)));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByRole("menu").count(), 1, "a catalog refresh must preserve the independent filters owner");
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "hidden" });
    await page.evaluate(() => (window as any).fixture.setRows((window as any).fixture.initial));
    // The list-level display menu remains exclusive with row menus.
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByRole("menu").waitFor();
    // Native pointer input also exercises the modal menu's outside dismissal.
    const rowBounds = await page.locator(".sidebar-activity-item").first().boundingBox();
    assert.ok(rowBounds);
    await page.mouse.click(rowBounds.x + rowBounds.width / 2, rowBounds.y + rowBounds.height / 2, { button: "right" });
    await page.getByRole("menuitem", { name: "Archive", exact: true }).waitFor();
    assert.equal(await page.getByRole("menu").count(), 1);
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "hidden" });
    // Hidden/removed/disabled targets cannot leave an orphan menu owner.
    for (const change of ["disabled", "removed", "mode"]) {
      await page.locator(".sidebar-activity-item").first().click({ button: "right" });
      await page.getByRole("menu").waitFor();
      await page.evaluate(change => {
        const f = (window as any).fixture;
        if (change === "disabled") f.setRows(f.initial.map((row: any, i: number) => i === 0 ? { ...row, interactionAvailable: false } : row));
        else if (change === "removed") f.setRows(f.initial.slice(1));
        else f.setMode(null);
      }, change);
      await page.getByRole("menu").waitFor({ state: "hidden" });
      await page.evaluate(() => (window as any).fixture.setRows((window as any).fixture.initial));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.getByRole("menu").count(), 0, "restoring a disabled/removed row must not restore its old menu");
    }
    assert.deepEqual(errors, []);
    evidence.push({ rows, cpuRate: 4, samples, interactionRegression: true });
    await page.close();
  }
  for (const touch of [false, true]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({viewport:{width:390,height:800},hasTouch:touch,isMobile:touch});
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.addInitScript('window.__name=v=>v');
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/?rows=3`);
    await page.locator('.sidebar-activity-item').nth(2).waitFor();
    await page.evaluate(theme => (window as any).fixture.setThemePreference(theme), theme);
    // The whole-list display context entrance remains separate from row actions.
    const contextHeading = page.locator('.sidebar-thread-group-toggle').first();
    const openListContext = async () => {
      if (touch) {
        const box = await contextHeading.boundingBox(); assert.ok(box);
        const cdp = await context.newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2,radiusX:1,radiusY:1,force:1,id:1}]});
        await page.waitForTimeout(850);
        await cdp.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
        await cdp.detach();
      } else await contextHeading.click({button:'right'});
      await page.getByRole('menu').waitFor();
    };
    const beforeListContext = await page.evaluate(() => ({rows:(window as any).rowsProcessed,projections:(window as any).projections}));
    await openListContext();
    assert.equal(await contextHeading.getAttribute('aria-expanded'), 'true', 'long press must not become a disclosure click');
    assert.equal(await page.getByRole('menuitemradio', {name:'Task flow',exact:true}).count(), 1);
    assert.equal(await page.getByRole('menuitem', {name:'Rename',exact:true}).count(), 0, 'heading context exposes display settings only');
    assert.deepEqual(await page.evaluate(() => ({rows:(window as any).rowsProcessed,projections:(window as any).projections})), beforeListContext, 'opening list context cannot rebuild the list');
    await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({state:'hidden'});
    await page.getByRole('button', {name:'Filters',exact:true}).click();
    await page.getByRole('menuitemradio', {name:'All servers',exact:true}).waitFor();
    assert.equal(await page.getByRole('menu').count(), 1, 'filters open after the modal list context closes');
    await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({state:'hidden'});
    const rowContextTarget = page.locator('.sidebar-activity-item').nth(1);
    const selectedBeforeRowContext = await page.locator('.sidebar-activity-item.is-selected').allTextContents();
    if (touch) {
      const box = await rowContextTarget.boundingBox(); assert.ok(box);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2,radiusX:1,radiusY:1,force:1,id:1}]});
      await page.waitForTimeout(850);
      assert.equal(await page.getByRole('menuitem', {name:'Rename',exact:true}).count(), 1, 'held row touch belongs to the row');
      await cdp.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
      await cdp.detach();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    } else await rowContextTarget.click({button:'right'});
    await page.getByRole('menuitem', {name:'Rename',exact:true}).waitFor();
    assert.equal(await page.getByRole('menu').count(), 1, 'nested row context retains the row owner after release');
    assert.deepEqual(await page.locator('.sidebar-activity-item.is-selected').allTextContents(), selectedBeforeRowContext, 'long press cannot select its underlying conversation');
    await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({state:'hidden'});
    await page.getByRole('button', {name:'People t0',exact:true}).click();
    await page.getByText('Participants t0', {exact:true}).waitFor();
    assert.equal(await page.getByRole('menu').count(), 0, 'badge opens after the modal row context closes');
    await page.keyboard.press('Escape'); await page.getByText('Participants t0', {exact:true}).waitFor({state:'hidden'});
    await openListContext();
    await page.getByRole('menuitemradio', {name:'Task flow',exact:true}).click();
    await page.getByRole('button', {name:'Recent',exact:true}).waitFor();
    await page.getByRole('menu').waitFor({state:'hidden'});
    await page.getByRole('button', {name:'Filters',exact:true}).click();
    await page.getByRole('menuitemradio', {name:'By creator',exact:true}).click();
    await page.getByRole('button', {name:'All conversations',exact:true}).waitFor();
    if (!touch) {
      await page.locator('.sidebar-list-toolbar > span').click({button:'right'});
      await page.getByRole('menuitemradio', {name:'Task flow',exact:true}).waitFor();
      assert.equal(await page.getByRole('menu').count(), 1);
      await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({state:'hidden'});
    }
    evidence.push({listContext:true,touch,theme,nativeOpen:true,noDisclosureClick:true,nativeRowRelease:true,isolatedOpen:true,exclusiveOwners:true,modeSelection:true});
    // Creator metadata must not change the group heading's reserved avatar geometry.
    const heading = page.locator('.sidebar-thread-group-toggle').first();
    const groupOffset = () => heading.evaluate(element => {
      const label = element.querySelector('.sidebar-thread-group-label')!.getBoundingClientRect();
      return label.left - element.getBoundingClientRect().left;
    });
    assert.equal(await heading.locator('.sidebar-thread-group-avatar').count(), 1, 'null creator photos keep the fallback slot');
    const fallbackOffset = await groupOffset();
    await page.evaluate(() => {
      (window as any).groupRow = document.querySelector('.sidebar-activity-item');
      (window as any).fixture.setGroupAvatar('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="10" fill="gray"/></svg>');
    });
    await heading.locator('img').waitFor();
    assert.ok(Math.abs(await groupOffset() - fallbackOffset) < 0.5, 'creator photo arrival cannot move the group label');
    assert.equal(await page.evaluate(() => (window as any).groupRow === document.querySelector('.sidebar-activity-item')), true);
    const checkDisclosure = async () => {
      const button = page.locator('.sidebar-thread-group-toggle').first();
      const targetId = await button.getAttribute('aria-controls');
      assert.ok(targetId, 'group disclosure identifies its controlled list');
      const target = page.locator('.sidebar-activity-group__items').first();
      assert.equal(await target.getAttribute('id'), targetId);
      await button.focus(); await button.press('Enter');
      assert.equal(await button.getAttribute('aria-expanded'), 'false');
      assert.equal(await target.getAttribute('hidden'), '');
      await button.press('Enter');
      assert.equal(await button.getAttribute('aria-expanded'), 'true');
      assert.equal(await target.getAttribute('hidden'), null);
      assert.equal(await button.getAttribute('aria-controls'), targetId, 'expansion retains the original target identity');
    };
    await checkDisclosure();
    await page.evaluate(() => (window as any).fixture.setMode(null));
    await page.getByRole('button', { name: 'Recent', exact: true }).waitFor();
    await checkDisclosure();
    await page.evaluate(() => (window as any).fixture.setMode('creator'));
    await page.getByRole('button', { name: 'All conversations', exact: true }).waitFor();
    evidence.push({groupHeading:true,touch,theme,fallbackOffset,stablePhotoOffset:true,keyboardDisclosures:true});
    // Row availability gates new badge opens as well as existing owners.
    const people = page.getByRole('button', { name: 'People t0', exact: true });
    const participants = page.getByText('Participants t0', { exact: true });
    const setUnavailable = () => page.evaluate(() => {
      const f = (window as any).fixture;
      f.setRows(f.initial.map((row: any, i: number) => i === 0 ? { ...row, interactionAvailable: false } : row));
    });
    await setUnavailable();
    await page.waitForFunction(() => (document.querySelector('.sidebar-activity-item') as HTMLButtonElement)?.disabled);
    if (touch) await people.tap(); else await people.click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await participants.count(), 0, 'an unavailable row cannot acquire the badge menu owner');
    await page.evaluate(() => (window as any).fixture.setRows((window as any).fixture.initial));
    if (touch) await people.tap(); else await people.click();
    await participants.waitFor();
    await setUnavailable();
    await participants.waitFor({ state: 'hidden' });
    await page.evaluate(() => (window as any).fixture.setRows((window as any).fixture.initial));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await participants.count(), 0, 'availability recovery cannot resurrect the badge menu');
    if (touch) await people.tap(); else await people.click();
    await participants.waitFor();
    await page.keyboard.press('Escape');
    await participants.waitFor({state:'hidden'});
    assert.deepEqual(errors, []);
    evidence.push({availability:true,touch,theme,explicitReopen:true});
    await context.close();
  }
  for (const touch of [false, true]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({viewport:{width:390,height:800},hasTouch:touch,isMobile:touch});
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/?rows=3&title`);
    await page.locator('.sidebar-activity-item').nth(2).waitFor();
    await page.evaluate(theme => (window as any).fixture.setThemePreference(theme), theme);
    assert.equal(await page.locator('[data-row-lines="one"]').count(),3);
    assert.equal(await page.locator('.sidebar-activity-item__metadata').count(),0);
    assert.ok((await page.locator('.sidebar-activity-item').first().getAttribute('title'))?.includes('workspace'));
    const geometry=await page.locator('.sidebar-activity-item-container').evaluateAll(rows=>rows.map(row=>{
      const title=row.querySelector('.sidebar-activity-item__title')!.getBoundingClientRect();
      const badge=row.querySelector('.sidebar-activity-item__badge-slot')!.getBoundingClientRect();
      return {clear:title.right<=badge.left,center:Math.abs(title.y+title.height/2-badge.y-badge.height/2)};
    }));
    assert.ok(geometry.every(row=>row.clear&&row.center<1),JSON.stringify(geometry));
    await page.getByRole('button',{name:'People t0',exact:true}).click();
    await page.getByText('Participants t0',{exact:true}).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Actions for Conversation 0',exact:true}).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem',{name:'Pin',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>(window as any).actions),['pin']);
    evidence.push({titleOnly:true,touch,theme,geometry});
    await context.close();
  }
  console.log(JSON.stringify({ passed: true, output, evidence }));
} finally {
  await writeFile(`${output}/result.json`, JSON.stringify(evidence, null, 2));
  await browser?.close(); await vite.close();
}
