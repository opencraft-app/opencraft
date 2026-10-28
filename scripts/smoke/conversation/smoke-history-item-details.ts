import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { mkdir } from "node:fs/promises";
const root=fileURLToPath(new URL("../../../",import.meta.url));
const vite=await createServer({configFile:false,root,logLevel:"error",esbuild:{jsx:"automatic"},resolve:{dedupe:["react","react-dom"]},server:{host:"127.0.0.1",port:0},plugins:[{name:"history-details",configureServer(server){server.middlewares.use((request,response,next)=>{if(!request.url?.startsWith('/?'))return next();response.setHeader('content-type','text/html');response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/history-item-details.tsx"></script>');});}}]});
let browser;
try{
 await vite.listen();const address=vite.httpServer!.address();assert.ok(address&&typeof address!=='string');
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const output=process.env.HISTORY_DETAIL_REPORT;if(output)await mkdir(output,{recursive:true});
 for(const width of [390,1200])for(const theme of ['light','dark']){
  const page=await browser.newPage({viewport:{width,height:800},hasTouch:width===390,isMobile:width===390});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript('window.__name=value=>value');
  await page.goto(`http://127.0.0.1:${address.port}/?theme=${theme}`);
  const trigger=page.locator('.thread-activity-item__hit-target');await trigger.waitFor();
  assert.equal(await page.evaluate(()=>(window as any).detailReads),0);
  await trigger.click();await page.waitForFunction(()=>(window as any).detailReads===1);
  await page.evaluate(()=>(window as any).completeDetail());await page.getByText('EXACT_COMPLETE_SUFFIX',{exact:false}).waitFor();
  assert.equal(await trigger.getAttribute('aria-expanded'),'true');
  if(output)await page.screenshot({path:`${output}/${width}-${theme}.png`});
  await trigger.click();await trigger.click();assert.equal(await page.evaluate(()=>(window as any).detailReads),1);
  assert.deepEqual(errors,[]);
  await page.goto(`http://127.0.0.1:${address.port}/?theme=${theme}`);await trigger.waitFor();await trigger.click();await page.waitForFunction(()=>(window as any).detailReads===1);
  await page.evaluate(()=>(window as any).hide());await page.waitForFunction(()=>(window as any).cancelled);
  assert.deepEqual(errors,[]);
  await page.goto(`http://127.0.0.1:${address.port}/?theme=${theme}`);await trigger.waitFor();await trigger.click();await page.waitForFunction(()=>(window as any).detailReads===1);
  await page.evaluate(()=>(window as any).disconnect());
  await page.evaluate(()=>(window as any).reconnect());
  await page.waitForFunction(()=>(window as any).detailReads===2, undefined, {timeout:3000});
  assert.equal(await trigger.getAttribute('aria-expanded'),'true');
  await page.evaluate(()=>(window as any).completeDetail());await page.getByText('EXACT_COMPLETE_SUFFIX',{exact:false}).waitFor();
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('history detail disclosure: closed/no reads, full restore, stable open/reopen and cancellation passed at 390/1200 in light/dark');
}finally{await browser?.close();await vite.close();}
