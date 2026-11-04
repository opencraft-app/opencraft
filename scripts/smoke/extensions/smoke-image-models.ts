import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
const out=process.env.OPENCRAFT_MODEL_PROOF_DIRECTORY??'.local/image-model-proof';await mkdir(out,{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:'.local/image-model-vite',logLevel:'error',esbuild:{jsx:'automatic'},resolve:{dedupe:['react','react-dom']},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'image-model-proof',configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root" style="height:100dvh"></div><script type="module" src="/tests/fixtures/image-model-page.tsx"></script></body></html>');});}}]});
let browser;try{
 await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 for(const touch of [false,true]){
  const page=await browser.newPage({viewport:{width:touch?390:1280,height:960},hasTouch:touch,isMobile:touch});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript('window.__name=target=>target;');await page.goto(server.resolvedUrls!.local[0]);
  await page.getByText('仅用于非订阅 Codex 的图像生成；订阅模型继续使用原有生图服务。当前已验证普通背景和单张参考图。',{exact:true}).waitFor();
  const menu=page.getByLabel('模型操作：ep-fixture',{exact:true});if(touch)await menu.tap();else await menu.click();
  const choose=page.getByRole('button',{name:'设为默认：ep-fixture',exact:true});if(touch)await choose.tap();else await choose.click();
  await page.getByText('已设为非订阅 Codex 的生图模型',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'获取模型',exact:true}).count(),0);
  await page.getByRole('button',{name:'编辑',exact:true}).click();await page.getByLabel('API Key',{exact:true}).waitFor();
  for(const width of [1280,390,320]){await page.setViewportSize({width,height:960});await page.screenshot({path:`${out}/image-model-${touch?'touch':'mouse'}-${width}.png`,fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`overflow ${width}`);}
  const proof=await page.evaluate(()=>(window as any).imageModelProof.calls);const saved=proof.find((c:any)=>c.method==='runtime/settings/mutate');assert.equal(saved.params.ns,'image-generation');assert.deepEqual(saved.params.ops[0].value,{provider:'image-fixture',model:'ep-fixture'});assert.equal(proof.some((c:any)=>c.method==='runtime/models/inspect'||c.method==='runtime/models/probe'),false);
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('image model UI: mouse/touch 1280/390/320, independent default and no implicit inference passed');
}finally{await browser?.close();await server.close();}
