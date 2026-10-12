import assert from "node:assert/strict";
import { createServer } from "vite";

// Real Sidebar, IOA controller and Radix badge; only native metadata RPC is a fixture.
const source = `
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {Sidebar} from '/apps/workbench-web/src/components/sidebar.tsx';
import {SidebarLayoutStore} from '@opencraft/sidebar-layout';
import {legacyDirectServerProjectionFromHost} from '@opencraft/workbench-runtime';
import {TencentOaParticipantsController} from '/plugins/tencentoa/src/participants-controller.ts';
import {createParticipantsBadge} from '/plugins/tencentoa/src/participants-view.tsx';
import {TENCENTOA_PARTICIPANTS_METHOD,TENCENTOA_PARTICIPANTS_CHANGED} from '/plugins/tencentoa/src/contract.ts';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_scope,doc)=>doc});
const listeners=new Set(), actions=[], calls=[];
const names={first:['alice','bob','carol'],second:['alice','bob','carol','dave','emma','frank','grace']};
const client={connectionGeneration:1,initializeResult:{capabilities:{extensions:{[TENCENTOA_PARTICIPANTS_METHOD]:{version:1}}}},
 requestRaw:async(method,params)=>{calls.push(params);return {data:params.threadIds.map(threadId=>({threadId,revision:1,participants:names[threadId]}))}},
 subscribeNotification:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},subscribeStatus:()=>()=>{},subscribeRequestLifecycle:()=>()=>{}};
const controller=new TencentOaParticipantsController(()=>client), badge=createParticipantsBadge(controller);
const threads=['first','second'].map((id,index)=>({id,title:index?'部署核查':'接口排查',project:'runtime',status:'ready',lineage:'root',time:'Now',updatedAt:Math.floor(Date.now()/1000),connectionHostId:'local',connectionHostLabel:'Local',...legacyDirectServerProjectionFromHost({hostId:'local',hostKind:'local',label:'Local'})}));
window.fixture={actions,calls,setThemePreference,change:(threadId,values)=>{names[threadId]=values;for(const fn of listeners)fn({method:TENCENTOA_PARTICIPANTS_CHANGED,params:{threadId,revision:2}})}};
const threadActions={onRename:async()=>{},onFork:async()=>{},onArchive:async()=>{},onDelete:async()=>{}};
createIntlTestRoot(document.getElementById('root'),undefined,'zh-CN').render(<div style={{height:'100vh',width:300,display:'flex',flexDirection:'column'}}><Sidebar
 threads={threads} activeHostId='local' activeThreadId='first' sidebarLayout={layout} threadBadge={badge} threadActions={threadActions}
 threadCapabilities={()=>({rename:true,archive:true,fork:true,delete:true})}
 onSelectThread={(hostId,id)=>actions.push({hostId,id})} onNewTask={()=>{}} onOpenSettings={()=>{}} /></div>);
`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-ioa-participants",
  esbuild: { jsx: "automatic", target: "esnext" }, server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "ioa-participants-probe", resolveId: id => id === "/participants-probe.tsx" ? id : null,
    load: id => id === "/participants-probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== "/") return next();
      res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/participants-probe.tsx"></script>');
    }); },
  }],
});
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  for (const touch of [false, true]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 844 }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
    const page = await context.newPage(), errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(vite.resolvedUrls!.local[0]!);
    await page.evaluate(theme => (window as any).fixture.setThemePreference(theme), theme);
    const badges = page.locator('.ioa-participants__badge');
    await badges.filter({ hasText: "+3" }).waitFor();
    assert.deepEqual(await badges.allTextContents(), ["+3", "+7"]);
    for (const badge of await badges.all()) {
      const box = await badge.boundingBox(); assert.ok(box && Math.abs(box.width - box.height) < 1, "badge is a circle");
      assert.equal(await badge.evaluate((node: HTMLElement) => getComputedStyle(node).borderRadius), "50%");
      assert.equal(await badge.evaluate((node: HTMLElement) => node.parentElement!.closest('button')), null, "independent button, no nested navigation button");
    }
    await badges.nth(1).click();
    const popovers = page.locator('.ioa-participants__popover');
    await popovers.waitFor(); assert.equal(await popovers.locator('li').count(), 7);
    await badges.nth(0).click(); await popovers.waitFor(); assert.equal(await popovers.count(), 1);
    assert.deepEqual(await popovers.locator('li').allTextContents(), ["alice", "bob", "carol"]);
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.actions), [], "badge click does not select a conversation");
    await page.keyboard.press('Escape'); await popovers.waitFor({ state: "detached" });
    await badges.nth(0).focus(); await page.keyboard.press('Enter'); await popovers.waitFor();
    await page.keyboard.press('Escape');
    await page.evaluate(() => (window as any).fixture.change('first', ['alice','bob','carol','dave']));
    await badges.filter({ hasText: "+4" }).waitFor();
    await badges.nth(0).click();
    await page.locator('.sidebar-activity-item').nth(1).click({ button: 'right', position: { x: 20, y: 10 } });
    await popovers.waitFor({ state: 'detached' });
    await page.getByRole('menu').waitFor();
    await page.keyboard.press('Escape');
    await badges.nth(1).click(); await popovers.waitFor();
    await page.keyboard.press('Escape'); await popovers.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.classList.contains('ioa-participants__badge'));
    assert.deepEqual(errors, []);
    if (!touch && theme === "light") await page.screenshot({ path: process.env.OPENCRAFT_IOA_PARTICIPANTS_SCREENSHOT ?? "/tmp/opencraft-ioa-participants.png" });
    await context.close();
  }
  console.log("PASS: real IOA circular badges +3/+7, participant popover, live count, no navigation, keyboard and menu exclusivity; mobile/desktop light/dark");
} finally { await browser?.close(); await vite.close(); }
