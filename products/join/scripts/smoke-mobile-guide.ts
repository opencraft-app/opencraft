import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import {createServer} from 'vite';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=await import('playwright');
const output='.local/mobile-guide-experience';
const source=`
import React from 'react';
import {bindWorkbenchPreview,isMobileWorkbenchPreview} from '/apps/workbench-web/src/runtime/workbench-preview.ts';
import {bindInteractionDensity} from '/apps/workbench-web/src/runtime/interaction-density.ts';
import {MemoryUiPreferenceStore,UiPreferencesRuntime} from '@opencraft/ui-preferences';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createWebWorkbenchApplication,WorkbenchRoot} from '/apps/workbench-web/src/workbench-root.tsx';
import {initializeAppearanceTheme,setThemePreference,setAppearanceThemeId} from '/apps/workbench-web/src/appearance-theme.ts';
import {createSmokeClientProduct} from '/tests/fixtures/client-product.ts';
import {registerMobileGuide} from '/products/join/plugins/tencentoa/src/mobile-guide-browser.ts';
import {createMobileGuideQr} from '/products/join/plugins/tencentoa/src/mobile-guide-qr.ts';
import {localeCatalogs} from '/apps/workbench-web/src/i18n/catalogs.ts';
import mobileMessages from '/products/join/plugins/tencentoa/src/locales/zh-CN.json';
import '/apps/workbench-web/src/styles/app.scss';
// Exercise an established workspace; first-use onboarding owns its own input layer.
localStorage.setItem("opencraft.onboarding.completedAt","2026-11-12T00:00:00Z");
initializeAppearanceTheme();
bindWorkbenchPreview();
const preferences=await UiPreferencesRuntime.open({installation:new MemoryUiPreferenceStore()});
bindInteractionDensity(document,preferences,isMobileWorkbenchPreview()?{touchFriendly:"on"}:undefined);
const config=document.createElement("script");config.id="opencraft-deployment-config";config.type="application/json";config.textContent=JSON.stringify({hosts:[{hostId:"fixture-host",label:"Fixture Host",kind:"remote-ssh",url:location.origin.replace("http","ws")+"/fixture-rpc"}],builtinAgents:false,hypernode:false});document.head.append(config);
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory',clientProduct:createSmokeClientProduct([],false)});
const supervisor=application.supervisor;
await supervisor.extensions.activate({manifest:{manifestVersion:1,id:'tencentoa.identity',name:'Phone guide fixture',version:'1.0.0',apiVersion:1,trust:'trusted',platforms:['web'],activationEvents:['onStartupFinished']},activate(api){registerMobileGuide(api,{getSnapshot:()=>({identity:{staffId:'fixture'}}),subscribe:()=>()=>{}} as any);}});
const catalogs=localeCatalogs.map(c=>c.locale==='zh-CN'?{...c,load:async()=>({...await c.load(),...mobileMessages})}:c);
createIntlTestRoot(document.getElementById('app'),undefined,'zh-CN',catalogs).render(<WorkbenchRoot application={application}/>);
window.proof={qr:createMobileGuideQr,theme:setThemePreference,themeId:setAppearanceThemeId,retire:()=>supervisor.extensions.deactivate('tencentoa.identity'),open:()=>supervisor.extensions.contributions.executeCommand('tencentoa.identity.mobile-guide.open')};
// Synthetic conversation behind the real modal reveals tint and scrim mistakes
// that a completely empty Workbench cannot expose. No real account data is used.
if (!isMobileWorkbenchPreview()) {
 const backdrop=document.createElement('section');backdrop.dataset.materialProof='true';
 backdrop.style.cssText='position:fixed;inset:96px 64px 100px 320px;z-index:1;pointer-events:none;overflow:hidden;color:var(--color-text);font:var(--typography-body-font);line-height:1.8';
 backdrop.innerHTML='<p style="margin:24px 0 50px auto;padding:14px 20px;width:fit-content;border-radius:20px;background:var(--color-background-navigation-current)">在手机上继续处理这项工作</p><h2 style="font:var(--typography-panel-title-font)">工作进展</h2><p>项目资料已经整理完成，可以随时继续查看。</p><p>最近的会话、工具和工作区都会保留。</p><p style="margin-top:48px">打开手机预览，可以直接操作当前工作区。</p><p>左右拖动展开侧栏，查看聊天和工具。</p><p style="margin:48px 0 30px auto;padding:14px 20px;width:fit-content;border-radius:20px;background:var(--color-background-navigation-current)">好的，保留当前进度。</p><p>你的草稿和当前选择会继续保留。</p>';
 document.body.append(backdrop);
}
document.body.dataset.ready='true';
`;
const vite = await createServer({ configFile: false, root: process.cwd(), cacheDir: output + "/vite-cache", publicDir: "apps/workbench-web/public", logLevel: "error",
  optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "@opencraft/remote-interaction", "@opencraft/remote-interaction/touch", "@opencraft/remote-interaction/websocket"] },
  define: { "import.meta.env.VITE_OPENCRAFT_PRESENTATION": JSON.stringify(JSON.stringify({ iconStyle: "classic" })), "process.env.NEXT_PUBLIC_REGION": '"cn"', "process.env.NEXT_PUBLIC_PREVIEW_LOCALES": '""',
    "import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN": '"false"', "import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN": '"false"' },
  esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] }, server: { host: "127.0.0.1", port: 0, hmr: false, allowedHosts: ["join.localhost"] },
  plugins: [{ name: "overhome-smoke", resolveId: id => id === "/proof.tsx" ? id : null, async load(id) {
    if (id === "/proof.tsx") return source;
    if (/\/packages\/(browser-core|remote-interaction)\/src\/.*\.cjs$/.test(id)) {
      const names = Object.keys(require(id));
      const bundled = await build({ stdin: { resolveDir: process.cwd(), contents: `export {${names.join(",")}} from ${JSON.stringify(id)}` }, bundle: true, format: "esm", platform: "browser", write: false });
      return bundled.outputFiles[0].text;
    }
    return null;
  },
    configureServer(server) { server.middlewares.use((request, response, next) => {
      if (request.url !== "/") return next(); response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="app"></div><script type="module" src="/proof.tsx"></script>');
    }); } }],
});

let browser:any;
try {
 await mkdir(output,{recursive:true});await vite.listen();
 const local=new URL(vite.resolvedUrls!.local[0]!);local.hostname='join.localhost';const url=local.href;
 browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox','--no-proxy-server','--host-resolver-rules=MAP join.localhost 127.0.0.1']});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];
 page.on('pageerror',(e:any)=>{errors.push(e.message);console.error(e.message)});
 page.setDefaultTimeout(60000);
 await page.addInitScript("window.__name=value=>value");
 await page.addInitScript(() => {
  (window as any).collapsedPreviewFrames=[];
  const sample=()=>{const el=document.querySelector<HTMLElement>('.announcement-experience-surface');
   if(el&&el.offsetHeight<100)(window as any).collapsedPreviewFrames.push(el.offsetHeight);
   requestAnimationFrame(sample);};requestAnimationFrame(sample);
 });
 let releaseFrame!:()=>void;
 const frameGate=new Promise<void>(resolve=>{releaseFrame=resolve;});
 await page.route('**/*',async route=>{
  const request=route.request();
  if(request.isNavigationRequest()&&request.frame().parentFrame())await frameGate;
  await route.continue();
 });
 await page.goto(url,{waitUntil:"domcontentloaded",timeout:120000});await page.locator('body[data-ready=true]').waitFor({timeout:120000});
 const entry=page.locator('[data-action-id="tencentoa.identity.mobile-guide.entry"]:visible');
 const experience=page.locator('.announcement-experience');
 await experience.waitFor({timeout:120000});
 await page.locator('.announcement-experience__qr:visible').waitFor();
 await page.getByText('用微信扫一扫，打开当前工作区。',{exact:true}).waitFor();
 assert.equal(await page.locator('.announcement-experience iframe').count(),1,'QR and live preview mount together');
 await page.waitForTimeout(400);
 await page.screenshot({path:output+'/initial-qr.png'});
 await page.getByRole('dialog').screenshot({path:output+'/qr-card.png'});
 // Optional external decoder keeps test tooling out of the product dependency graph.
 if(process.env.OPENCRAFT_QR_DECODER){
  const decode=require(process.env.OPENCRAFT_QR_DECODER);const sharp=require('sharp');const results=[];
  for(const value of ['https://join.woa.com/', 'https://join.woa.com/servers/hub-d00bd6f39112a3c11a62656c397b9515c5a1f2e2/local/01a1c41d-e5ad-7d82-a38d-31233b8398d6?hostId=local-codex', 'https://join.woa.com/local/01a1c41d-e5ad-7d82-a38d-31233b8398d6?hostId=local-codex&draftId=01a1c41d-e5ad-7d82-a38d-31233b8398d6']){
   const data=await page.evaluate(value=>window.proof.qr(value),value);
   const png=Buffer.from(data.split(',')[1],'base64');
   for(const width of [224,448]){
    const {data:raw,info}=await sharp(png).resize(width,width).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(decode(new Uint8ClampedArray(raw),info.width,info.height)?.data,value,'branded QR roundtrip at displayed size');
    let green=0;for(let i=0;i<raw.length;i+=4)if(raw[i]<50&&raw[i+1]>130&&raw[i+2]<150)green++;
    assert.ok(green>30,'WeChat badge is embedded in the PNG');results.push({value,width,green});
   }
  }
  await writeFile(output+'/qr-decoding.json',JSON.stringify(results,null,2));
 }
 await page.locator('.announcement-experience__loading').waitFor();
 await page.waitForTimeout(400);
 const loadingBox=await page.getByRole('dialog').boundingBox();
 assert.ok(loadingBox&&loadingBox.height>400&&loadingBox.width>=760&&loadingBox.width<=880,'first paint reserves the complete phone experience');
 await page.waitForTimeout(400);
 assert.deepEqual(await page.evaluate(()=>(window as any).collapsedPreviewFrames),[],'no empty modal frame before content loads');
 await page.screenshot({path:output+'/loading.png'});
 releaseFrame();
 const frame=page.frameLocator('.announcement-experience iframe');
 await frame.locator('body[data-ready=true]').waitFor({timeout:120000});
 await page.locator('.announcement-experience__loading').waitFor({state:'hidden'});
 const readyBox=await page.getByRole('dialog').boundingBox();
 assert.ok(readyBox&&Math.abs(readyBox.height-loadingBox!.height)<2&&Math.abs(readyBox.width-loadingBox!.width)<2,'loading does not resize the modal');
 assert.equal(await frame.locator('html').getAttribute('data-ui-density'),'touch');
 assert.equal(await frame.locator('.announcement-experience').count(),0);
 assert.equal(await frame.locator('[data-action-id="tencentoa.identity.mobile-guide.entry"]').count(),0);
 const evidence=[];
 const settleTheme=async()=>page.locator('.modal-surface__close:visible').evaluate(async button=>{
  // Capture the settled shared control, rather than its first color-transition frame.
  await Promise.all(button.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));
 });
 for(const theme of ['light','dark']) {
  await page.evaluate(t=>window.proof.theme(t),theme);
  await page.waitForFunction(t=>document.documentElement.dataset.theme===t,theme);
  await frame.locator('html[data-theme="'+theme+'"]').waitFor();
  await settleTheme();
  const box=await page.getByRole('dialog').boundingBox();assert(box&&box.x>=0&&box.y>=0&&box.x+box.width<=1441&&box.y+box.height<=1001);
  evidence.push({theme,box});await page.screenshot({path:output+'/'+theme+'.png'});
  await frame.locator('body').evaluate(body => { const input=document.createElement('input');input.id='continuity-proof';input.value='keep my draft';body.append(input); });
  await page.locator('.announcement-experience__qr:visible').waitFor();
  assert.equal(await page.locator('.announcement-experience__phone').getAttribute('inert'),null);
  assert.equal(await frame.locator('#continuity-proof').inputValue(),'keep my draft');
  await frame.locator('#continuity-proof').evaluate(el=>el.remove());
 }
 for (const mode of ['light','dark']) {
  await page.evaluate(mode=>{window.proof.themeId('opencraft.core.frost');window.proof.theme(mode);},mode);
  await page.waitForTimeout(300);await settleTheme();
  await page.screenshot({path:output+'/frost-'+mode+'.png'});
  const colors=await page.locator('.announcement-experience').evaluate(el=>({text:getComputedStyle(el).color,background:getComputedStyle(el.parentElement!).backgroundColor}));
  evidence.push({theme:'frost-'+mode,colors});
 }
 for(const viewport of [{width:800,height:600},{width:390,height:700}]){
  await page.setViewportSize(viewport);await page.waitForTimeout(350);
  const actions=page.locator('.announcement-experience__actions');await actions.scrollIntoViewIfNeeded();
  const box=await actions.boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=viewport.width&&box.y+box.height<=viewport.height,'actions remain reachable');
  await page.locator('.announcement-experience__qr').scrollIntoViewIfNeeded();
  await page.screenshot({path:output+'/narrow-'+viewport.width+'.png'});
 }
 await page.setViewportSize({width:1440,height:1000});
 await page.locator('.announcement-experience__phone').scrollIntoViewIfNeeded();
 await page.waitForTimeout(400);
 const phone=await page.locator('.announcement-experience iframe').boundingBox();assert(phone);
 const pageSurface=frame.locator('.app-shell-row').first();
 const offset=()=>pageSurface.evaluate(el=>new DOMMatrix(getComputedStyle(el).transform).m41);
 // Wait for the shared spring's visual endpoint, not an assumed 500 ms duration.
 const waitForClosed=()=>pageSurface.evaluate(el=>new Promise<void>((resolve,reject)=>{
  const deadline=performance.now()+3000;
  const check=()=>{if(Math.abs(new DOMMatrix(getComputedStyle(el).transform).m41)<1)resolve();
   else if(performance.now()>deadline)reject(new Error('sidebar did not settle closed'));
   else requestAnimationFrame(check);};check();
 }));
 // Mouse drag uses real pointer events and must move while still held.
 const x=phone.x+70,y=phone.y+140;
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+100,y,{steps:8});
 // Motion values are painted on the next animation frame while the pointer remains held.
 await pageSurface.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
 assert.ok(await offset()>60,'mouse drag follows the pointer before release');
 await page.mouse.move(x+220,y,{steps:8});await page.mouse.up();await page.waitForTimeout(500);
 assert.ok(await offset()>100,'mouse swipe opens the sidebar');
 await page.mouse.move(phone.x+phone.width-35,y);await page.mouse.down();await page.mouse.move(phone.x+40,y,{steps:15});await page.mouse.up();await page.waitForTimeout(500);
 await waitForClosed();
 assert.ok(Math.abs(await offset())<1,'mouse swipe closes the sidebar');
 // Editable content keeps native selection/caret handling, not sidebar panning.
 await pageSurface.evaluate(el=>{const input=document.createElement('input');input.id='gesture-editor';input.value='editable draft';input.style.cssText='position:absolute;top:240px;left:40px;width:220px;z-index:10';el.append(input);});
 const editor=await frame.locator('#gesture-editor').boundingBox();assert(editor);
 await page.mouse.move(editor.x+20,editor.y+10);await page.mouse.down();await page.mouse.move(editor.x+180,editor.y+10,{steps:10});await page.mouse.up();
 assert.ok(Math.abs(await offset())<1,'editing does not open the sidebar');
 assert.equal(await frame.locator('#gesture-editor').inputValue(),'editable draft');
 await frame.locator('#gesture-editor').evaluate(el=>el.remove());
 await frame.locator('body').evaluate(()=>window.getSelection()?.removeAllRanges());
 await page.screenshot({path:output+'/interactive-preview.png'});
 await frame.locator('body').evaluate(body=>{body.tabIndex=-1;body.focus();});
 await page.keyboard.press('Escape');await experience.waitFor({state:'hidden'});
 await entry.click();await experience.waitFor();await page.locator('.announcement-experience__qr:visible').waitFor();assert.equal(await page.locator('.announcement-experience__actions button').count(),0);await page.locator('.modal-surface__close:visible').click();await experience.waitFor({state:'hidden'});
 assert.equal(await page.evaluate(()=>localStorage.getItem('tencentoa.identity.mobile-guide.seen.v1')),'1');
 await page.reload();await entry.waitFor();await page.waitForTimeout(500);assert.equal(await page.getByRole('dialog').count(),0);
 await entry.click();await experience.waitFor();await frame.locator('body[data-ready=true]').waitFor({timeout:120000});await page.waitForTimeout(500);
 // Actual browser touch input reaches the same owner inside the iframe.
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
 const touch=async(type:string,dx:number)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x:x+dx,y,radiusX:1,radiusY:1,id:1}]});
 await touch('touchStart',0);for(const dx of [30,70,120,180,220])await touch('touchMove',dx);
 assert.ok(await offset()>60,'touch drag follows the contact');await touch('touchEnd',220);await page.waitForTimeout(500);
 assert.ok(await offset()>100,'touch opens the sidebar');
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:phone.x+phone.width-35,y,id:1}]});
 for(const dx of [40,80,140,200])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:phone.x+phone.width-35-dx,y,id:1}]});
 await touch('touchEnd',0);await waitForClosed();assert.ok(Math.abs(await offset())<1,'touch closes the sidebar');
 await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});await cdp.detach();
 await page.evaluate(()=>window.proof.retire());await experience.waitFor({state:'hidden'});
 const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});await mobile.goto(url,{timeout:120000});await mobile.locator('body[data-ready=true]').waitFor();await mobile.waitForTimeout(500);
 assert.equal(await mobile.getByRole('dialog').count(),0);assert.equal(await mobile.locator('[data-action-id="tencentoa.identity.mobile-guide.entry"]').count(),0);
 assert.deepEqual(errors,[]);
 await writeFile(output+'/evidence.json',JSON.stringify({evidence,checks:['QR and live phone side by side','first paint has full geometry','held iframe loading and stable bounds','real WorkbenchRoot','interactive iframe','light/dark projection','Escape','mouse and touch sidebar open/close, held drag, editor exclusion','narrow and short viewports','seen persistence','retirement','touch suppression'],errors},null,2));
 console.log('PASS mobile experience in real WorkbenchRoot');
}finally{await browser?.close();await vite.close();}
