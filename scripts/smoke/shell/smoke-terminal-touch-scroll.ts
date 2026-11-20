import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const output=process.env.OPENCRAFT_SMOKE_OUTPUT??'.local/terminal-touch-scroll';await mkdir(output,{recursive:true});
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom']},cacheDir:'node_modules/.vite-terminal-keyboard',esbuild:{jsx:'automatic',target:'esnext'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'terminal-scroll',configureServer(server){server.middlewares.use((req,res,next)=>{if(!req.url?.startsWith('/?'))return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/terminal-keyboard.tsx"></script>');});}}]});
let browser;const reports=[];
try{
 await vite.listen();browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
 for(const theme of ['light','dark'])for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:844},hasTouch:true,isMobile:width<1000});const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{(window as any).__name=(v:unknown)=>v;document.addEventListener('DOMContentLoaded',()=>document.documentElement.dataset.uiDensity='touch');});
  await page.goto(vite.resolvedUrls!.local[0]+'?gesture');
  const host=page.locator('.terminal-panel__host');await host.locator('.xterm-rows').waitFor();await page.evaluate(theme=>(window as any).fixture.setThemePreference(theme),theme);
  const original=await host.locator('.xterm').elementHandle();const viewport=host.locator('.xterm-viewport');const top=()=>viewport.evaluate(n=>n.scrollTop);
  const box=await host.locator('.xterm-screen').boundingBox();assert(box);const x=box.x+50,y=box.y+65;
  const cdp=await context.newCDPSession(page);const touch=(type:string,yy=y,xx=x)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'||type==='touchCancel'?[]:[{x:xx,y:yy,id:1}]});
  const emit=async(text:string)=>{await page.evaluate(text=>(window as any).fixture.emit(text),text);await page.waitForTimeout(70);};
  const writes=()=>page.evaluate(()=>(window as any).fixture.writes.join(''));
  const clearWrites=()=>page.evaluate(()=>(window as any).fixture.writes.length=0);
  await viewport.evaluate(n=>n.scrollTop=n.scrollHeight);await page.waitForTimeout(50);
  const positions=[await top()];await touch('touchStart');
  for(const dy of [45,90,135,180]){await touch('touchMove',y+dy);await page.waitForTimeout(50);positions.push(await top());}
  await touch('touchEnd');
  assert(positions.every((v,i)=>i===0||v<positions[i-1]!-15),'continuous history drag must survive text redraws: '+positions);
  assert.equal(await writes(),'','history scrolling sends no PTY input');
  const reading=await top();await emit('incoming while reading\r\n');assert(Math.abs(await top()-reading)<box.height/25,'new output preserves history position within row alignment');
  await touch('touchStart',y+180);await touch('touchMove',y+120);await touch('touchMove',y+50);await touch('touchEnd');assert(await top()>reading+60,'reverse drag returns toward latest output');
  await page.screenshot({path:output+'/'+width+'-'+theme+'.png'});
  // Alt screen has no history: let xterm handle standard/application cursor keys.
  await emit('\x1b[?1049h\x1b[2J\x1b[HFull screen\r\n');await clearWrites();
  await touch('touchStart');await touch('touchMove',y+60);await touch('touchMove',y+120);await touch('touchEnd');
  assert.match(await writes(),/^(\x1b\[A)+$/,'alternate buffer uses xterm up-arrow routing');
  await emit('\x1b[?1h');await clearWrites();
  await touch('touchStart',y+150);await touch('touchMove',y+80);await touch('touchEnd');assert.match(await writes(),/^(\x1bOB)+$/,'application cursor mode retained');
  await clearWrites();await touch('touchStart');await emit('\x1b[?1049l');await touch('touchMove',y+90);await touch('touchEnd');assert.equal(await writes(),'','a held non-mouse TUI pan cannot send stale arrows to the restored shell');
  await emit('\x1b[?1049h');
  await emit('\x1b[?1000h\x1b[?1006h');await clearWrites();
  await touch('touchStart');await touch('touchMove',y+60);await touch('touchMove',y+120);await touch('touchEnd');
  const mouse=await writes();assert.match(mouse,/^(\x1b\[<64;\d+;\d+M)+$/,'mouse TUI receives SGR wheel packets, never arrows');assert((mouse.match(/M/g)??[]).length>=4,'fast drag keeps wheel distance');
  // Do not carry a held alternate-screen gesture into the restored shell.
  await clearWrites();await touch('touchStart');await emit('\x1b[?1000l\x1b[?1006l\x1b[?1049l\x1b[?1l');await touch('touchMove',y+90);await touch('touchEnd');assert.equal(await writes(),'');
  await viewport.evaluate(n=>n.scrollTop=n.scrollHeight);await page.waitForTimeout(50);const restored=await top();assert(restored>0);
  await touch('touchStart');await touch('touchMove',y+50);await touch('touchCancel');const cancelled=await top();await page.waitForTimeout(150);assert.equal(await top(),cancelled);
  // Clear saved lines: a shell with no scrollback must not receive arrow keys.
  await emit('\x1b[3J\x1b[2J\x1b[H');await clearWrites();await touch('touchStart');await touch('touchMove',y+100);await touch('touchEnd');assert.equal(await writes(),'');
  await page.getByRole('button',{name:'Show keyboard',exact:true}).tap();await page.keyboard.type('pwd');assert.equal(await writes(),'pwd');
  assert(await host.locator('.xterm').evaluate((n,old)=>n===old,original));assert.deepEqual(errors,[]);
  reports.push({width,theme,positions,normalHistory:true,alternateCursor:true,applicationCursor:true,sgrMouse:true,modeSwitch:true,cancel:true,emptyShell:true,terminalRetained:true});await context.close();
 }
 await writeFile(output+'/report.json',JSON.stringify(reports,null,2));console.log(JSON.stringify({ok:true,reports}));
}finally{await browser?.close();await vite.close();}
