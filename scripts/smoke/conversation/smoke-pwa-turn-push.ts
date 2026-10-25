import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');
const artifacts=await mkdtemp(join(tmpdir(),'opencraft-pwa-push-ui-'));
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},cacheDir:'node_modules/.vite-pwa-push',esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'notification-fixture',configureServer(server){server.middlewares.use((req,res,next)=>{
 if(req.url?.split('?')[0]!=='/')return next();res.setHeader('content-type','text/html');res.end('<html><body><div id="root"></div><script type="module" src="/tests/fixtures/turn-notifications.tsx"></script></body></html>');
});}}]});
let browser:any;
try{
 await vite.listen();const origin=`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
 browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
 for(const [width,scheme] of [[390,'light'],[1200,'dark']] as const){
  const context=await browser.newContext({viewport:{width,height:844},colorScheme:scheme,hasTouch:width===390});
  let enabled=false,fail=false;const calls:any[]=[];
  await context.route('**/__opencraft_push',async(route:any)=>{
   const request=route.request();
   if(request.method()==='GET')return route.fulfill({json:{available:true,publicKey:'fixture-public',actorId:'actor',hosts:['host-a']}});
   const input=request.postDataJSON();calls.push(input);
   if(fail)return route.fulfill({status:503,json:{error:'unavailable'}});
   if(input.operation==='subscribe')enabled=true;if(input.operation==='unsubscribe')enabled=false;
   return route.fulfill({json:{enabled,sent:input.operation==='test'}});
  });
  const page=await context.newPage(),errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));
  await page.addInitScript('window.__name=value=>value');await page.goto(origin+'/?push=1');
  await page.waitForFunction(()=>!!(window as any).__turnNotificationFixture);
  await page.evaluate(mode=>(window as any).__turnNotificationFixture.theme(mode),scheme);
  const toggle=page.getByRole('switch',{name:'轮次结束提醒',exact:true});await toggle.waitFor();
  assert.equal(await toggle.count(),1);assert.equal(await page.getByRole('switch',{name:'后台轮次通知',exact:true}).count(),0);
  await page.waitForFunction(()=>!document.querySelector('[aria-label="轮次结束提醒"]')?.hasAttribute('disabled'));
  assert.equal(await toggle.getAttribute('aria-checked'),'false');await toggle.click();await page.waitForFunction(()=>document.querySelector('[aria-label="轮次结束提醒"]')?.getAttribute('aria-checked')==='true');
  assert.equal(calls.find(c=>c.operation==='subscribe').messages.completed,'OpenCraft · 本轮已完成');
  await page.getByRole('button',{name:'发送测试通知',exact:true}).click();await page.getByText('测试通知已提交推送服务，请查看设备通知。').waitFor();
  assert.equal(calls.filter(c=>c.operation==='test').length,1);
  await page.screenshot({path:join(artifacts,`${width}-${scheme}-enabled.png`),fullPage:true});
  await toggle.click();await page.waitForFunction(()=>document.querySelector('[aria-label="轮次结束提醒"]')?.getAttribute('aria-checked')==='false');assert.equal(enabled,false);
  fail=true;await toggle.click();await page.getByText('未能更新推送通知。请检查网络连接和通知权限后重试。').waitFor();assert.equal(await toggle.getAttribute('aria-checked'),'false');
  fail=false;await toggle.click();await page.waitForFunction(()=>document.querySelector('[aria-label="轮次结束提醒"]')?.getAttribute('aria-checked')==='true');
  await page.reload();await toggle.waitFor();await page.waitForFunction(()=>document.querySelector('[aria-label="轮次结束提醒"]')?.getAttribute('aria-checked')==='true');
  await page.waitForFunction(()=>(window as any).__turnNotificationFixture.notificationSettings().delivery==='background');
  assert.equal(await toggle.count(),1);await toggle.click();await page.waitForFunction(()=>document.querySelector('[aria-label="轮次结束提醒"]')?.getAttribute('aria-checked')==='false');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);await context.close();
 }
 const ordinary=await browser.newContext();const ordinaryPage=await ordinary.newPage();await ordinaryPage.addInitScript('window.__name=value=>value');await ordinaryPage.goto(origin);await ordinaryPage.getByRole('switch',{name:'轮次结束提醒',exact:true}).waitFor();assert.equal(await ordinaryPage.getByRole('switch',{name:'后台轮次通知',exact:true}).count(),0);assert.equal(await ordinaryPage.getByRole('switch',{name:'轮次结束提醒',exact:true}).count(),1);await ordinary.close();
 await writeFile(join(artifacts,'evidence.json'),JSON.stringify({result:'pass',widths:[390,1200],deviceAndPushService:'synthetic boundaries',real:['ChatSettings','IntlRuntime','TurnNotificationController','PwaTurnPushController','preferences','DOM','touch context'],physicalIPhone:false},null,2));
 console.log(`PASS PWA push settings: enrollment, localized payload, test acknowledgement, unsubscribe, failure/retry, ordinary-browser exclusion and responsive layout. ${artifacts}`);
}finally{await browser?.close();await vite.close();}
