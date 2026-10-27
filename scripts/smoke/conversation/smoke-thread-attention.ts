// Real Conversation/IntersectionObserver; deterministic platform focus boundary.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const { chromium } = await import('playwright');
const vite = await createServer({configFile:false,root:process.cwd(),logLevel:'error',esbuild:{jsx:'automatic'},
  server:{host:'127.0.0.1',port:0}, plugins:[{name:'attention-receipt-smoke',configureServer(server){
    server.middlewares.use((request,response,next)=>{
      if(request.url?.split('?')[0]!=='/') return next();
      response.setHeader('content-type','text/html');
      response.end('<div id="root"></div><script type="module" src="/tests/fixtures/conversation-scroll.tsx"></script>');
    });
  }}]});
let browser;
try {
  await vite.listen(); browser = await chromium.launch({headless:true,args:['--no-sandbox']});
  const context = await browser.newContext({viewport:{width:1200,height:800}});
  const page = await context.newPage();
  // Playwright forces all tabs focused. Substitute only this browser boundary,
  // retaining real DOM, scrolling, intersection and occlusion measurement.
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(vite.resolvedUrls!.local[0]+'?natural');
  await page.waitForFunction(()=>Boolean((window as any).api));
  await page.evaluate("window.receiptFocused=true; Object.defineProperty(document,'hasFocus',{value:()=>window.receiptFocused});");
  await page.bringToFront();
  await page.locator('.thread-scroll').hover();
  await page.mouse.wheel(0,-5000);
  await page.waitForTimeout(400);
  assert.ok(await page.locator('.thread-scroll').evaluate(el=>el.scrollTop < el.scrollHeight-el.clientHeight-100));
  await page.evaluate(()=>{(window as any).reads=[];(window as any).complete();});
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>(window as any).reads.includes('turn-5')),false,'selected conversation scrolled away is not read');
  // A result visible behind the mobile drawer must remain unread.
  await page.evaluate(()=>{const overlay=document.createElement('div');overlay.id='cover';overlay.style.cssText='position:fixed;inset:0;z-index:999999;background:white';document.body.append(overlay);});
  await page.locator('.thread-scroll').evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(()=>(window as any).reads.includes('turn-5')),false,'covered result is not read');
  await page.evaluate(()=>{document.getElementById('cover')!.remove();document.dispatchEvent(new Event('pointerup'));});
  await page.waitForFunction(()=>(window as any).reads.includes('turn-5'));
  // Completion while the browser has another foreground tab is not a receipt.
  await page.evaluate(()=>{(window as any).receiptFocused=false;window.dispatchEvent(new Event('blur'));});
  assert.equal(await page.evaluate(()=>document.hasFocus()),false,'focus boundary is background');
  await page.evaluate(()=>{(window as any).reads=[];(window as any).submit({local:false,height:80,phase:'final_answer'});});
  await page.waitForTimeout(150);await page.evaluate(()=>(window as any).complete());
  await page.locator('.thread-scroll').evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(()=>(window as any).reads.includes('turn-6')),false,'background result is not read');
  await page.evaluate(()=>{(window as any).receiptFocused=true;window.dispatchEvent(new Event('focus'));});
  await page.waitForFunction(()=>(window as any).reads.includes('turn-6'));
  assert.deepEqual(errors,[]);console.log('PASS real Conversation receipts: scrolled-away, covered, foreground and background results');
} finally {await browser?.close();await vite.close();}
