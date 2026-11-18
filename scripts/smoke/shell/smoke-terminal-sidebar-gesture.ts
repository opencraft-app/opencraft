import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const output=process.env.OPENCRAFT_SMOKE_OUTPUT??'.local/terminal-sidebar-gesture';await mkdir(output,{recursive:true});
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom']},cacheDir:'node_modules/.vite-terminal-keyboard',esbuild:{jsx:'automatic',target:'esnext'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'terminal-gesture',configureServer(server){server.middlewares.use((req,res,next)=>{if(!req.url?.startsWith('/?'))return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/terminal-keyboard.tsx"></script>');});}}]});
let browser;const reports=[];
try{
 await vite.listen();browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
 for(const theme of ['light','dark'])for(const reducedMotion of ['no-preference','reduce'] as const){
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,reducedMotion});const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>{errors.push(e.message);console.log(e.message)});
  await page.addInitScript(()=>{(window as any).__name=(v:unknown)=>v;document.addEventListener('DOMContentLoaded',()=>document.documentElement.dataset.uiDensity='touch');});
  await page.goto(vite.resolvedUrls!.local[0]+'?gesture');
  await page.locator('.opencraft-composer-editor').waitFor({state:'attached'});
  if(!(await page.locator('.terminal-panel').isVisible()))await page.locator('button.app-shell-header__right-panel-toggle').click();
  const host=page.locator('.terminal-panel__host');await page.waitForFunction(()=>document.querySelector('.terminal-panel__host')?.getAttribute('data-sidebar-gesture')==='vertical-pan');
  await page.evaluate(theme=>(window as any).fixture.setThemePreference(theme),theme);
  await page.waitForFunction(()=>document.querySelector('.app-shell-page-presentation')?.getAttribute('data-mobile-sidebar')==='true');
  const original=await host.locator('.xterm').elementHandle();const viewport=host.locator('.xterm-viewport');await viewport.evaluate(n=>n.scrollTop=120);
  const cdp=await context.newCDPSession(page);const touch=(type:string,x=80,y=280)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'||type==='touchCancel'?[]:[{x,y,id:1}]});
  const moved=()=>page.locator('.app-shell-page-presentation').evaluate(n=>n.getBoundingClientRect().x);
  const closed=()=>page.waitForFunction(()=>!document.querySelector('.app-shell-floating-left-panel'));
  // Negative control: removing only the surface declaration recreates the old native exclusion.
  await host.evaluate(n=>n.setAttribute('data-sidebar-gesture','ignore'));
  await touch('touchStart');await touch('touchMove',180);await touch('touchEnd');assert.equal(await moved(),0);
  await host.evaluate(n=>n.setAttribute('data-sidebar-gesture','vertical-pan'));
  const scroll=await viewport.evaluate(n=>n.scrollTop);
  await touch('touchStart');await touch('touchMove',140);await page.waitForTimeout(32);
  const held=await moved();assert(held>10&&held<250,'shared Shell must follow the held terminal contact: '+held);
  assert.equal(await viewport.evaluate(n=>n.scrollTop),scroll,'horizontal navigation does not also scroll terminal');
  await touch('touchMove',290);await touch('touchEnd');
  await page.waitForFunction(()=>{const n=document.querySelector('.app-shell-floating-left-panel');const front=document.querySelector('.app-shell-page-presentation');return n&&front&&Math.abs(front.getBoundingClientRect().x-n.getBoundingClientRect().width)<1;});
  const openX=await moved();assert(openX>150);await page.screenshot({path:output+'/'+theme+'-'+reducedMotion+'.png'});
  // Dismiss through the translated foreground page, not a terminal-local drawer.
  await touch('touchStart',365);await touch('touchMove',300);await touch('touchMove',100);await touch('touchEnd');await closed();
  // Vertical output scrolling belongs to xterm and cannot reveal navigation.
  const beforeY=await viewport.evaluate(n=>{n.scrollTop=160;return n.scrollTop;});
  await touch('touchStart',100,350);await touch('touchMove',102,280);await touch('touchEnd');
  assert.equal(await moved(),0);assert.notEqual(await viewport.evaluate(n=>n.scrollTop),beforeY);
  // Cancel restores the same Shell pose; a following tap still owns keyboard input.
  await touch('touchStart');await touch('touchMove',160);await touch('touchCancel');await closed();
  await page.getByRole('button',{name:'Show keyboard',exact:true}).tap();assert(await host.locator('textarea').evaluate(n=>document.activeElement===n));
  await page.keyboard.type('pwd');assert((await page.evaluate(()=>(window as any).fixture.writes.join(''))).endsWith('pwd'));
  // Mouse-reporting TUI output revokes the horizontal handoff through the public terminal mode.
  await page.evaluate(()=>(window as any).fixture.emit('\x1b[?1000h'));
  await page.waitForFunction(()=>document.querySelector('.terminal-panel__host')?.getAttribute('data-sidebar-gesture')==='ignore');
  await touch('touchStart');await touch('touchMove',200);await touch('touchEnd');assert.equal(await moved(),0);
  await page.evaluate(()=>(window as any).fixture.emit('\x1b[?1000l'));
  await page.waitForFunction(()=>document.querySelector('.terminal-panel__host')?.getAttribute('data-sidebar-gesture')==='vertical-pan');
  const screen=await host.locator('.xterm-screen').boundingBox();assert(screen);
  await page.mouse.move(screen.x+12,screen.y+12);await page.mouse.down();await page.mouse.move(screen.x+140,screen.y+12,{steps:5});await page.mouse.up();
  await page.waitForFunction(()=>document.querySelector('.terminal-panel__host')?.getAttribute('data-sidebar-gesture')==='ignore');
  await touch('touchStart');await touch('touchMove',200);await touch('touchEnd');assert.equal(await moved(),0,'terminal selection retains the contact');
  await page.mouse.click(screen.x+20,screen.y+30);
  await page.waitForFunction(()=>document.querySelector('.terminal-panel__host')?.getAttribute('data-sidebar-gesture')==='vertical-pan');
  await page.evaluate(()=>{const d=document.createElement('dialog');d.textContent='Foreground input';document.body.append(d);d.showModal();});
  await touch('touchStart');await touch('touchMove',200);await touch('touchEnd');assert.equal(await moved(),0,'foreground modal owns input above terminal');
  await page.evaluate(()=>{const d=document.querySelector('dialog')!;d.close();d.remove();});
  assert(await host.locator('.xterm').evaluate((n,old)=>n===old,original),'same terminal survives drawer gestures');assert.deepEqual(errors,[]);
  reports.push({theme,reducedMotion,held,openX,terminalRetained:true,verticalScroll:true,tuiExclusive:true,input:true});await context.close();
 }
 await writeFile(output+'/report.json',JSON.stringify(reports,null,2));console.log(JSON.stringify({ok:true,reports}));
}finally{await browser?.close();await vite.close();}
