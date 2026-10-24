import assert from "node:assert/strict";
import { createServer } from "vite";
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] }, server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "rail", configureServer(server) { server.middlewares.use((req, res, next) => { if (!req.url?.startsWith("/?")) return next(); res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/composer-attached-rail.tsx"></script>'); }); } }] });
const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
let browser: any;
try {
 await vite.listen(); browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
 const quick = process.argv.includes("--quick");
 for (const width of [390, 1280]) for (const palette of quick ? ["neutral"] : ["neutral", "canvas", "frost", "lavender", "mist", "graphite"]) for (const mode of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width, height: 700 }, hasTouch: width === 390 });
  const errors: string[] = []; page.on("pageerror", (e: Error) => { errors.push(e.message); console.error(e.message); });
  page.on("console", m => { if(m.type() === "error") console.error(m.text()); });
  page.on("response", r => { if(r.status() >= 400) console.error(r.status(),r.url()); });
  await page.addInitScript("window.__name=value=>value");
  await page.goto(`${vite.resolvedUrls!.local[0]}?palette=${palette}&mode=${mode}`);
  await page.evaluate(width=>{document.documentElement.dataset.uiDensity=width===390?'touch':'compact'},width);
  await page.locator('.opencraft-composer-queue-item').waitFor(); await page.waitForTimeout(250);
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
   assert.equal(layout.handleWidth, width === 390 ? 44 : 24, 'compact pointer handle keeps modest side padding; coarse target stays accessible');
   assert.equal(layout.opacity, '1'); assert.equal(layout.gripOpacity, '1');
   assert.equal(layout.photoActivatesDrag, false, 'sender photo is not a drag target');
   assert(layout.handleLeft-layout.rowLeft <= 4.1, 'reorder handle stays close to the leading edge');
   assert(layout.photoLeft-layout.handleRight <= 1, 'handle and author slots have no extra spacer');
  };
  await separateAuthorAndHandle();
  if(width !== 390) { await handle.hover(); await separateAuthorAndHandle(); }
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
     overlap: r.bottom - e.top, railChildren: [...rail.children].map(n => n.className),
     pill: p && { width:p.width, height:p.height, gap:(getComputedStyle(rail).display === 'none' ? e.top : r.top)-p.bottom,
      center: (p.left+p.right-e.left-e.right)/2, shellWidth:e.width,
      radius:css!.borderTopLeftRadius, shadow:css!.boxShadow, background:css!.backgroundColor,
      independent:!rail.contains(summary), overflow:summary!.scrollWidth > summary!.clientWidth } };
   });
   const hasQueue = state === 'both' || state === 'queue';
   const hasSummary = state === 'both' || state === 'summary';
   assert.equal(geometry.railVisible,hasQueue,JSON.stringify(geometry));
   if(hasQueue){ assert.equal(geometry.overlap,16); assert.deepEqual(geometry.railChildren,['opencraft-composer-queue-tray']); }
   else assert.equal(geometry.railHeight,0);
   assert.equal(!!geometry.pill,hasSummary);
   if(geometry.pill){
    const p=geometry.pill;
    assert.equal(p.independent,true); assert.equal(p.gap,8); assert(Math.abs(p.center)<1);
    assert(p.width < p.shellWidth-20); assert.equal(p.height,width===390?32:28);
    assert.equal(p.radius,'9999px'); assert.notEqual(p.shadow,'none');
    assert(!p.background.startsWith('rgba('),p.background); assert.equal(p.overflow,false);
    await page.locator('.thread-turn-diff-live').click();
    assert(await page.evaluate(()=>(window as any).reviewCount>0));
   }
   assert(await editor.evaluate((node, original) => node === original, originalEditor));
   assert.equal(await editor.innerText(), "Keep this draft");
   if (state === 'both') await page.screenshot({ path: `/tmp/rail-${width}-${palette}-${mode}.png` });
  }
  assert.deepEqual(errors, []); await page.close();
 }
 console.log(`PASS: ${quick ? 4 : 24} browser combinations, 4 occupancy states; separate centered content-width pill, 8px gap, opaque theme surface, review action, queue perimeter and bounded scroll.`);
} finally { await browser?.close(); await vite.close(); }
