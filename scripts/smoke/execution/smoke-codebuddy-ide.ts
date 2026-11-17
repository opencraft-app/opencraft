import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const output='/tmp/opencraft-codebuddy-ide-ui';
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom']},cacheDir:'node_modules/.vite-ide-onboarding',esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0},plugins:[{name:'fixture',configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/'&&!req.url?.startsWith('/?'))return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/agent-onboarding.tsx"></script>');});}}]});
await mkdir(output,{recursive:true});await vite.listen();
const browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
try{
 const errors:string[]=[];
 for(const touch of [false,true]){
  const context=await browser.newContext({viewport:{width:touch?390:1100,height:900},hasTouch:touch,isMobile:touch});const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  for(const state of ['connect','trust','sign-in','ready']){
   await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as {port:number}).port}/?management=1&ide=${state}&locale=zh-CN`);
   const ide=page.locator('li[data-agent="codebuddy-ide"]');await ide.waitFor();
   assert.match(await page.locator('li[data-agent="codebuddy"]').innerText(),/CodeBuddy CLI/);
   assert.match(await ide.innerText(),/CodeBuddy IDE/);
   if(state==='trust')await ide.getByRole('button',{name:'确认项目信任',exact:true}).waitFor();
   else if(state!=='ready')await ide.getByRole('button',{name:'接入 IDE',exact:true}).waitFor();
   assert.equal(await ide.getByRole('switch').isDisabled(),state!=='ready');
   if(state==='trust'){
    const action=ide.getByRole('button',{name:'确认项目信任',exact:true});
    if(touch)await action.tap();else{await action.focus();await page.keyboard.press('Enter');}
    await page.getByRole('alert').waitFor({state:'hidden'});
   }
   for(const theme of ['light','dark']){
    await page.evaluate(theme=>(window as any).onboardingFixture.setThemePreference(theme),theme);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:`${output}/${touch?'touch':'desktop'}-${state}-${theme}.png`});
   }
  }
  await context.close();
 }
 assert.deepEqual(errors,[]);console.log('IDE and CLI identities, connection/trust/login states, keyboard and touch composition passed.');
}finally{await browser.close();await vite.close();}
