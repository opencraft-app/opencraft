import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";

const output = process.env.OPENCRAFT_OVERVIEW_OUTPUT ?? "/tmp/opencraft-conversation-overview";
const miniChatSample = "已准备扩大到**上海 2 区**，保持 10 Mbps。\n\n- 入口与连接状态已核对\n- 配置路径为 `servers/join`\n\n[连接指南](javascript:alert(1)) ![示意图](https://preview.invalid/image.png)";
const source = `
import React,{useState,useMemo}from'react';
import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';
import{AppShell}from'/apps/workbench-web/src/components/app-shell.tsx';
import{AppShellHeader,AppShellNavigationControls}from'/apps/workbench-web/src/components/app-shell-header.tsx';
import{ConversationOverview,useConversationOverview}from'/apps/workbench-web/src/features/conversation-overview/index.tsx';
import{ConversationOverviewSetting}from'/apps/workbench-web/src/features/conversation-overview/setting.tsx';
import{createConversationOverviewSource}from'/apps/workbench-web/src/features/conversation-overview/source.ts';
import{legacyDirectServerProjectionFromHost}from'@opencraft/workbench-runtime';
import{initializeAppearanceTheme,setThemePreference,setAppearanceThemeId}from'/apps/workbench-web/src/appearance-theme.ts';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const params=new URL(location.href).searchParams;
document.documentElement.dataset.uiDensity=params.get('density')||'touch';
setThemePreference(params.get('theme')==='dark'?'dark':'light');
if(params.get('theme')==='frost')setAppearanceThemeId('opencraft.core.frost');
const fixture=window.fixture={reads:[],active:{},peak:{},scope:1,failRead:false,failSelect:false,selected:[],delay:60};
const client=new QueryClient();fixture.queryClient=client;
const initial=Array.from({length:40},(_,i)=>({id:i<2?'same':'t'+i,title:['Waiting for your review','Unread result','Running task'][i]||'Conversation '+i,project:'Workspace / project '+i,lineage:'root',time:'',status:i===0?'review':i===2?'running':'ready',updatedAt:1000-i,unread:i===1,connectionHostId:i===1?'remote':'local',connectionHostLabel:i===1?'Remote':'Local',interactionAvailable:true,...legacyDirectServerProjectionFromHost({hostId:i===1?'remote':'local',hostKind:'local',label:i===1?'Remote':'Local'})}));
const noop=()=>{};
function App(){
 const[open,setOpen]=useState(false),[rows,setRows]=useState(initial),[scope,setScope]=useState(1),[online,setOnline]=useState(true),[catalogError,setCatalogError]=useState(false);
 const overview=useConversationOverview();
 const sources=useMemo(()=>['local','remote'].map(hostId=>createConversationOverviewSource({key:hostId+':'+scope+':'+online,hostId,available:online,supported:true,assertCurrent:()=>{if(fixture.scope!==scope||!online)throw Error('revoked')},protocol:{request:async(method,params)=>{
  if(method!=='thread/turns/list')throw Error('unexpected method');fixture.reads.push({hostId,method,params});fixture.active[hostId]=(fixture.active[hostId]||0)+1;fixture.peak[hostId]=Math.max(fixture.peak[hostId]||0,fixture.active[hostId]);
  try{await new Promise(r=>setTimeout(r,fixture.delay));if(fixture.failRead&&hostId==='local'&&params.threadId==='same')throw Error('synthetic failure');return{data:[2,1].map(n=>({id:'turn'+n,items:[{type:'userMessage',id:'u'+n,content:[{type:'text',text:hostId+' prompt '+n+': Please check the latest changes and tell me what needs attention.'}]},{type:'agentMessage',id:'a'+n,text:hostId+' answer '+n+': '+${JSON.stringify(miniChatSample)}}]})),nextCursor:null}}
  finally{fixture.active[hostId]--}
 }}})),[scope,online]);
 Object.assign(fixture,{setCatalogError,update:()=>setRows(r=>r.map((v,i)=>i? v:{...v,updatedAt:v.updatedAt+1})),revoke:()=>{fixture.scope++;setScope(fixture.scope);setOnline(false)},renew:()=>{fixture.scope++;setScope(fixture.scope);setOnline(true)},hide:value=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:value?'hidden':'visible'});document.dispatchEvent(new Event('visibilitychange'))}});
 const actions=[...(overview.action?[overview.action]:[]),{id:'shell.search',title:'Search conversations',icon:'search',onInvoke:noop}];
 return <QueryClientProvider client={client}><AppShell layoutScope='overview-fixture' navigation={{layout:'unified',actions,onOpenSettings:noop,account:null}} mainContentLayout='thread-edge-scroll' sidebarOpen={open} sidebarWidth={335} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} onSidebarResizeEnd={noop} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={noop}
 header={<AppShellHeader title='Appearance' project={null} sidebarOpen={open} rightPanelOpen={false} rightPanelFullWidth={false} onToggleSidebar={()=>setOpen(!open)} onToggleRightPanel={noop} onHome={noop} canGoBack={false} canGoForward={false} onBack={noop} onForward={noop} navigationActions={['sidebar-toggle']}/>}
 floatingSidebarHeader={()=> <AppShellNavigationControls hostRole='transient' sidebarOpen brand={<span className='application-brand'>OpenCraft</span>} canGoBack={false} canGoForward={false} onToggleSidebar={()=>setOpen(false)} onHome={noop} onBack={noop} onForward={noop} actions={['sidebar-toggle']}/>}
 leftPanel={<div style={{padding:20}}>Existing conversation directory</div>}>
 <div style={{padding:'96px 24px'}}><h1>Appearance</h1><ConversationOverviewSetting/><input aria-label='Retained draft' defaultValue='Keep this draft'/></div>
 <ConversationOverview open={overview.open} onClose={overview.close} threads={rows.map(r=>({...r,interactionAvailable:online}))} sources={sources} loading={false} catalogs={[{hostId:'local',label:'Local',phase:catalogError?'error':'ready'}]} discovery={null} onRetryDiscovery={async()=>{}} onRetry={async()=>setCatalogError(false)} onSelect={async(hostId,id)=>{if(fixture.failSelect)return false;fixture.selected.push([hostId,id]);return true}}/>
 </AppShell></QueryClientProvider>
}
createIntlTestRoot(document.getElementById('root')).render(<App/>);
`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-conversation-overview",
  esbuild: { jsx: "automatic", target: "esnext" },
  optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "react-intl", "@tanstack/react-query", "motion/react", "@radix-ui/react-dialog", "@radix-ui/react-tooltip", "@radix-ui/react-popover", "@radix-ui/react-dropdown-menu", "@radix-ui/react-context-menu", "@radix-ui/react-alert-dialog", "sonner", "tslib"] },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "overview-fixture", resolveId: id => id === "/overview-fixture.tsx" ? id : null,
    load: id => id === "/overview-fixture.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/?")) return next();
      res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/overview-fixture.tsx"></script>');
    }); } }],
});
let browser: any;
const evidence: unknown[] = [];
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const width of [390, 1440]) for (const theme of ["light", "dark", "frost"]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width === 390 });
    const page = await context.newPage(); const errors: string[] = []; let external = 0;
    page.on("pageerror", (error: Error) => { errors.push(error.message); console.error("Fixture page error:", error.message); });
    page.on("console", (message: any) => { if (message.type() === "error") console.error("Fixture console:", message.text()); });
    page.on("request", (request: any) => { if (!request.url().startsWith("http://127.0.0.1:") && !request.url().startsWith("data:")) external++; });
    await page.addInitScript("window.__name=v=>v");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/?density=${width === 390 ? "touch" : "compact"}&theme=${theme}`);
    const setting = page.getByRole("switch", { name: "Conversation overview button", exact: true });
    await setting.waitFor(); assert.equal(await setting.getAttribute("aria-checked"), "false");
    await setting.click(); await page.locator('[data-app-shell-sidebar-trigger]:visible').first().click();
    const entrance = page.getByRole("button", { name: "Conversation overview", exact: true });
    await entrance.waitFor(); let placement: unknown = null;
    if (width === 390) {
      await page.waitForFunction(() => (document.querySelector('[data-action-id="shell.overview.header"]')?.getBoundingClientRect().width ?? 0) >= 43.99);
      const left = await page.locator('[data-action-id="shell.overview.header"]').boundingBox();
      const right = await page.locator('[data-action-id="shell.search.header"]').boundingBox();
      assert.ok(left && right && left.x + left.width <= right.x + .1 && left.width >= 43.9); placement = { left, right };
      assert.equal(await page.locator('[data-action-id="shell.overview.header"]').evaluate(node => getComputedStyle(node).width), '44px');
      assert.equal(await page.locator('[data-action-id="shell.overview"]:visible').count(), 0);
    }
    await entrance.click(); await page.locator('.conversation-overview').waitFor();
    await page.locator('.conversation-overview__assistant').first().waitFor();
    assert.equal(await page.locator('.conversation-overview__card').count(), 12);
    const first = page.locator('.conversation-overview__card').first();
    assert.equal(await first.getAttribute('data-status'), 'review');
    assert.equal(await first.locator('.conversation-overview__turn').count(), 2);
    assert.match(await first.innerText(), /local answer 2/);
    assert.deepEqual(await page.evaluate(() => Object.values((window as any).fixture.peak).every((n: any) => n <= 2)), true);
    assert.ok(await page.evaluate(() => (window as any).fixture.reads.length) <= 12);
    const mini = first.locator('[data-minichat="readonly"]');
    assert.equal(await mini.count(), 1);
    assert.ok(await mini.locator('strong').count() >= 2, 'Markdown emphasis is rendered');
    assert.ok(await mini.locator('li').count() >= 2, 'Markdown lists retain structure');
    assert.ok(await mini.locator('code').count() >= 2, 'inline code retains its semantic role');
    assert.equal(await mini.locator('a,img,iframe,video,audio,button,input,textarea,[tabindex]').count(), 0, 'thumbnail has no interactive or resource-loading DOM');
    assert.ok(!(await mini.innerText()).includes('**上海'), 'raw Markdown emphasis must not leak');
    const geometry = await first.evaluate(card => {
      const preview = card.querySelector('.conversation-overview__preview')!;
      const canvas = card.querySelector('.mini-chat')!;
      const caption = card.querySelector('.conversation-overview__caption')!;
      const assistant = card.querySelector('.mini-chat__message--assistant .mini-chat__prose')!;
      return { preview: preview.getBoundingClientRect().toJSON(), canvas: canvas.getBoundingClientRect().toJSON(), caption: caption.getBoundingClientRect().toJSON(),
        assistantMaxHeight: getComputedStyle(assistant).maxHeight, transform: getComputedStyle(canvas).transform,
        text: getComputedStyle(canvas).color, background: getComputedStyle(card.querySelector('.conversation-overview__frame')!).backgroundColor };
    });
    assert.ok(geometry.canvas.right <= geometry.preview.right + 1, 'miniature canvas fits the card');
    assert.ok(geometry.caption.top >= geometry.preview.bottom, 'normal-size identity remains outside the thumbnail');
    assert.notEqual(geometry.assistantMaxHeight, 'none', 'rich prose is bounded, without per-card scrollers');
    assert.equal(await page.locator('.conversation-overview__scroll').evaluate(node => node.scrollWidth <= node.clientWidth), true, 'grid has no horizontal overflow');
    const bounds = await page.locator('.conversation-overview').boundingBox();
    assert.ok(bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1);
    await page.screenshot({ path: `${output}/${width}-${theme}.png` });
    // Failed previews keep their card and provide a real, independently clickable retry.
    await page.evaluate(() => { (window as any).fixture.failRead = true; (window as any).fixture.update(); });
    const retry = first.getByRole('button', { name: 'Retry', exact: true }); await retry.waitFor();
    await page.evaluate(() => { (window as any).fixture.failRead = false; }); await retry.click();
    await retry.waitFor({ state: 'detached' });
    // Navigation failure does not discard the overview; successful selection uses Host + Thread.
    await page.evaluate(() => { (window as any).fixture.failSelect = true; });
    await first.getByRole('button', { name: 'Waiting for your review · Local', exact: true }).click();
    await page.getByText('Could not open this conversation. Try again.', {exact:true}).waitFor(); assert.equal(await page.locator('.conversation-overview').count(), 1);
    await page.evaluate(() => { (window as any).fixture.failSelect = false; });
    await first.getByRole('button', { name: 'Waiting for your review · Local', exact: true }).click();
    await page.locator('.conversation-overview').waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.selected), [['local', 'same']]);
    if (width === 390) await entrance.waitFor({ state: 'detached' });
    if (!await entrance.isVisible()) await page.locator('[data-app-shell-sidebar-trigger]:visible').first().click();
    await entrance.click(); await page.locator('.conversation-overview__assistant').first().waitFor();
    if (width === 390 && theme === 'light') {
      await page.evaluate(() => (window as any).fixture.hide(true)); await page.waitForTimeout(200);
      const reads = await page.evaluate(() => (window as any).fixture.reads.length);
      await page.waitForTimeout(4300); assert.equal(await page.evaluate(() => (window as any).fixture.reads.length), reads);
      await page.evaluate(() => (window as any).fixture.hide(false));
      await page.waitForFunction((before: number) => (window as any).fixture.reads.length > before, reads, { timeout: 6000 });
    }
    await page.getByRole('button', { name: 'Show more', exact: true }).click();
    assert.equal(await page.locator('.conversation-overview__card').count(), 24);
    await page.evaluate(() => (window as any).fixture.revoke());
    await page.waitForFunction(() => !document.querySelector('.conversation-overview__assistant'));
    assert.equal(await first.getByRole('button', { name: 'Waiting for your review · Local', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => (window as any).fixture.queryClient.getQueryCache().findAll({ queryKey: ['conversation-overview'] }).length), 0);
    assert.equal(await page.getByLabel('Retained draft').inputValue(), 'Keep this draft');
    assert.deepEqual(errors, []); assert.equal(external, 0);
    evidence.push({ width, theme, placement, bounds, geometry, errors, externalRequests: external, subscriptionCacheReleased: true });
    await context.close();
  }
  await writeFile(output + '/result.json', JSON.stringify({ passed: true, cases: evidence }, null, 2));
  console.log(JSON.stringify({ passed: true, cases: evidence }));
} finally { await browser?.close(); await vite.close(); }
