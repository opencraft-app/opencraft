import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
const out=process.env.OPENCRAFT_MODEL_PROOF_DIRECTORY??'.local/model-capability-proof';await mkdir(out,{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:'.local/model-capability-vite',logLevel:'error',esbuild:{jsx:'automatic'},resolve:{dedupe:['react','react-dom']},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'model-capability-proof',configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root" style="height:100dvh"></div><script type="module" src="/tests/fixtures/model-capability-page.tsx"></script></body></html>');});}}]});
let browser;try{
 await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 const touch=process.env.OPENCRAFT_MODEL_PROOF_TOUCH==='1';
 const page=await browser.newPage({viewport:{width:touch?390:1280,height:960},hasTouch:touch,isMobile:touch});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript('window.__name = target => target;');await page.goto(server.resolvedUrls!.local[0]);
 const menu=page.getByLabel('模型操作：vendor/flash',{exact:true}); if(touch)await menu.tap();else await menu.click();await page.getByRole('button',{name:'查看与检测模型能力'}).click();
 await page.getByRole('button',{name:'获取已知能力'}).click();await page.getByText('models.dev · 原厂参考，部署上限可能不同 · 已有配置保留',{exact:true}).first().waitFor();
 assert.equal(await page.getByLabel('模型上下文长度',{exact:true}).inputValue(),'262144');
 assert.equal(await page.getByRole('button',{name:'补全空值并保存'}).isDisabled(),true);
 assert.equal(await page.evaluate(()=>(window as any).modelCapabilityProof.calls.filter((c:any)=>c.method==='runtime/providers/apply').length),0);
 await page.getByRole('button',{name:'验证接口能力'}).click();await page.getByText('图片：验证通过 · 合成测试通过',{exact:true}).waitFor();
 for(const width of [1280,390,320]){
  await page.setViewportSize({width,height:960});await page.screenshot({path:`${out}/model-capabilities-${touch?"touch":"mouse"}-${width}.png`,fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`horizontal overflow at ${width}`);
  await page.getByRole('button',{name:'保存长度设置'}).scrollIntoViewIfNeeded();
 }
 await page.getByLabel('模型上下文长度',{exact:true}).fill('524288');await page.getByRole('button',{name:'保存长度设置'}).click();
 await page.getByText('模型长度限制已保存；新会话使用新预算',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>(window as any).modelCapabilityProof.calls.filter((c:any)=>c.method==='runtime/providers/apply').at(-1).params.models[0].contextWindow),524288);
 assert.deepEqual(errors,[]);console.log('model capability UI: desktop/narrow, preview, preserved 256K, verification and explicit save passed');
}finally{await browser?.close();await server.close();}
