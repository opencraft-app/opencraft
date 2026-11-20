import assert from "node:assert/strict";
import { createServer } from "vite";
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] }, server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "rail", configureServer(server) { server.middlewares.use((req, res, next) => { if (!req.url?.startsWith("/?")) return next(); res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/composer-attached-rail.tsx"></script>'); }); } }] });
const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
let browser: any;
try {
 await vite.listen(); browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
 const quick = process.argv.includes("--quick");
 for (const width of [320, 390, 1280]) for (const palette of quick ? ["neutral", "lavender"] : ["neutral", "canvas", "frost", "lavender", "mist", "graphite"]) for (const mode of ["light", "dark"]) for (const navigation of [false, true]) {
  const touch = width < 1280;
  const page = await browser.newPage({ viewport: { width, height: 700 }, hasTouch: touch });
  const errors: string[] = []; page.on("pageerror", (e: Error) => { errors.push(e.message); console.error(e.message); });
  page.on("console", m => { if(m.type() === "error") console.error(m.text()); });
  page.on("response", r => { if(r.status() >= 400) console.error(r.status(),r.url()); });
  await page.addInitScript("window.__name=value=>value");
  await page.goto(`${vite.resolvedUrls!.local[0]}?palette=${palette}&mode=${mode}&locale=${touch?'zh-CN':'en-US'}${navigation?'&navigation':''}`);
  await page.evaluate(touch=>{document.documentElement.dataset.uiDensity=touch?'touch':'compact'},touch);
  await page.locator('.opencraft-composer-queue-item').waitFor(); await page.waitForTimeout(250);
  if(navigation && width===320 && palette==='neutral' && mode==='light'){
   const old=await page.addStyleTag({content:'.opencraft-composer-floating-content{display:contents}.opencraft-composer-stack:has(>.opencraft-composer-navigation>*)>.opencraft-composer-floating-content{grid-column:auto;grid-row:auto}.opencraft-composer-stack:has(>.opencraft-composer-navigation>*)>.opencraft-composer-attached-rail{grid-row:1}.opencraft-composer-stack:has(>.opencraft-composer-navigation>*)>.opencraft-composer-shell,.opencraft-composer-stack:has(>.opencraft-composer-navigation>*)>.opencraft-composer-navigation{grid-row:2}'});
   const broken=await page.evaluate(()=>{const s=document.querySelector('.opencraft-composer-shell')!.getBoundingClientRect(),p=document.querySelector('.thread-live-changes')!.getBoundingClientRect();return p.right>s.right+1;});
   assert(broken,'old auto-placement must reproduce a file summary in the navigation column');
   await page.screenshot({path:'/tmp/queue-summary-before.png'});await old.evaluate(n=>n.remove());
  }
  const row = page.locator('.opencraft-composer-queue-item').first();
  const handle = row.locator('.opencraft-composer-queue-item__drag');
  const separateAuthorAndHandle = async () => {
   const layout = await row.evaluate(e => {
    const handle = e.querySelector('.opencraft-composer-queue-item__drag')!;
    const photo = e.querySelector('.opencraft-composer-queue-item__avatar')!;
    const grip = e.querySelector('.opencraft-composer-queue-item__grip')!;
    const text = e.querySelector('.opencraft-composer-queue-item__preview')!;
    return {rowLeft:e.getBoundingClientRect().left, handleLeft:handle.getBoundingClientRect().left,
     handleRight:handle.getBoundingClientRect().right, handleWidth:handle.getBoundingClientRect().width, photoLeft:photo.getBoundingClientRect().left,
     photoRight:photo.getBoundingClientRect().right, textLeft:text.getBoundingClientRect().left,
     opacity:getComputedStyle(photo).opacity, gripOpacity:getComputedStyle(grip).opacity,
     photoActivatesDrag:handle.contains(photo)};
   });
   assert(layout.handleRight <= layout.photoLeft && layout.photoRight <= layout.textLeft, 'handle, sender and text occupy separate slots');
   assert.equal(layout.handleWidth, touch ? 44 : 24, 'compact pointer handle keeps modest side padding; coarse target stays accessible');
   assert.equal(layout.opacity, '1'); assert.equal(layout.gripOpacity, '1');
   assert.equal(layout.photoActivatesDrag, false, 'sender photo is not a drag target');
   assert(layout.handleLeft-layout.rowLeft <= 4.1, 'reorder handle stays close to the leading edge');
   assert(layout.photoLeft-layout.handleRight <= 1, 'handle and author slots have no extra spacer');
  };
  await separateAuthorAndHandle();
  if(!touch) { await handle.hover(); await separateAuthorAndHandle(); }
  else { await handle.tap(); await separateAuthorAndHandle(); }
  await handle.focus(); await separateAuthorAndHandle();
  await page.evaluate(() => (window as any).setRailCount(8));
  const tray = page.locator('.opencraft-composer-queue-tray');
  await page.locator('.opencraft-composer-queue-item').last().scrollIntoViewIfNeeded();
  assert(await tray.evaluate((node:HTMLElement) => node.scrollTop > 0 && node.clientHeight < node.scrollHeight));
  await page.evaluate(() => (window as any).setRailCount(1));
  const editor = page.locator(".opencraft-composer-editor");
  await editor.fill("Keep this draft");
  const originalEditor = await editor.elementHandle();
  for (const state of ["both", "summary", "queue", "empty"]) {
   await page.evaluate((state: string) => (window as any).setRailState(state), state); await page.waitForTimeout(30);
   const geometry = await page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>('.opencraft-composer-attached-rail')!;
    const shell = document.querySelector<HTMLElement>('.opencraft-composer-shell')!;
    const summary = document.querySelector<HTMLElement>('.thread-live-changes');
    const r = rail.getBoundingClientRect(), e = shell.getBoundingClientRect(), p = summary?.getBoundingClientRect();
    const css = summary && getComputedStyle(summary);
    return { railVisible: getComputedStyle(rail).display !== 'none', railHeight: r.height,
     overlap: r.bottom - e.top, expectedOverlap:parseFloat(getComputedStyle(rail).getPropertyValue('--overlap-composer-rail')), railChildren: [...rail.children].map(n => n.className),
     pill: p && { width:p.width, height:p.height, gap:(getComputedStyle(rail).display === 'none' ? e.top : r.top)-p.bottom,
      center: (p.left+p.right-e.left-e.right)/2, shellWidth:e.width,
      radius:css!.borderTopLeftRadius, shadow:css!.boxShadow, background:css!.backgroundColor,
      independent:!rail.contains(summary), overflow:summary!.scrollWidth > summary!.clientWidth } };
   });
   const hasQueue = state === 'both' || state === 'queue';
   const hasSummary = state === 'both' || state === 'summary';
   assert.equal(geometry.railVisible,hasQueue,JSON.stringify(geometry));
   if(hasQueue){
    assert(Math.abs(geometry.overlap-geometry.expectedOverlap)<1,JSON.stringify(geometry)); assert.deepEqual(geometry.railChildren,['opencraft-composer-queue-tray']);
    assert(await row.evaluate(n=>{const r=n.getBoundingClientRect();return [...n.querySelectorAll('button')].every(b=>{const v=b.getBoundingClientRect();const text=b.querySelector('span');return v.left>=r.left && v.right<=r.right && v.bottom<=r.bottom && (!text || text.getBoundingClientRect().height<=parseFloat(getComputedStyle(text).lineHeight)+1);});}),'queue actions stay inside the row with horizontal labels');
    if(state==='both'){
     if(touch)await row.locator('.is-steer').tap();else await row.locator('.is-steer').click();
     assert.equal(await page.evaluate(()=>(window as any).steerCount),1,'one click steers exactly once');
    }
   }
   else assert.equal(geometry.railHeight,0);
   assert.equal(!!geometry.pill,hasSummary);
   if(geometry.pill){
    const p=geometry.pill;
    assert.equal(p.independent,true); assert.equal(p.gap,8); assert(Math.abs(p.center)<1);
    assert(p.width < p.shellWidth);
    assert.equal(p.radius,'9999px'); assert.notEqual(p.shadow,'none');
    assert(!p.background.startsWith('rgba('),p.background); assert.equal(p.overflow,false);
    await page.locator('.thread-turn-diff-live').click();
    assert(await page.evaluate(()=>(window as any).reviewCount>0));
   }
   assert(await editor.evaluate((node, original) => node === original, originalEditor));
   assert.equal(await editor.innerText(), "Keep this draft");
   if(navigation){
    const positions=await page.evaluate(()=>{const rect=(s:string)=>document.querySelector(s)!.getBoundingClientRect();const shell=rect('.opencraft-composer-shell'),nav=rect('.opencraft-composer-navigation');return {gap:nav.left-shell.right,bottom:nav.bottom-shell.bottom,width:shell.width,stack:rect('.opencraft-composer-stack').width,nav:nav.width};});
    assert(positions.gap>=0 && Math.abs(positions.bottom)<1,JSON.stringify(positions));
    assert(positions.width>positions.stack-positions.nav-30,'summary must not consume a second grid column');
    if(touch)await page.getByRole('button',{name:'Tools',exact:true}).tap();else await page.getByRole('button',{name:'Tools',exact:true}).click();
    assert(await page.evaluate(()=>(window as any).navigationCount>0));
   }
   if (state === 'both') await page.screenshot({ path: `/tmp/rail-${width}-${palette}-${mode}-${navigation?'navigation':'plain'}.png` });
  }
  assert.deepEqual(errors, []); await page.close();
 }
 console.log(`PASS: ${quick ? 24 : 72} browser combinations, 4 occupancy states; file summary, queue and navigation preserve editor width, draft, actions and bounded scroll.`);
} finally { await browser?.close(); await vite.close(); }
