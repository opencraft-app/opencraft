import assert from "node:assert/strict";
import { createServer } from "vite";
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:"error",esbuild:{jsx:"automatic"},resolve:{dedupe:["react","react-dom"]},server:{host:"127.0.0.1",port:0},plugins:[{name:"entry-defaults",configureServer(server){server.middlewares.use((req,res,next)=>{if(!req.url?.startsWith("/?"))return next();res.setHeader("content-type","text/html");res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/touch-newera.tsx"></script>')})}}]});
const playwright=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??"playwright");
const {chromium}=playwright.default??playwright;
await vite.listen();const browser=await chromium.launch({executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:["--no-sandbox"]});
try {
 for(const entry of ["standalone","embedded"]) for(const touch of [true,false]) for(const mode of ["light","dark"]){
  const context=await browser.newContext({viewport:{width:touch?390:1280,height:844},hasTouch:touch});
  const page=await context.newPage();const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.addInitScript("window.__name=value=>value");
  await page.goto(`${vite.resolvedUrls!.local[0]}?entry=${entry}&mode=${mode}`);
  const editor=page.locator('.opencraft-composer-editor');await editor.waitFor();
  await page.waitForFunction(()=>typeof(window as any).setTouch==="function");
  await page.evaluate(touch=>(window as any).setTouch(touch),touch);
  const toggle=page.getByRole('switch',{name:'触控端 Newera 体验'});
  const on=entry==="standalone";
  assert.equal(await toggle.getAttribute('aria-checked'),String(on));
  assert.equal(await page.locator('.opencraft-composer-shell').evaluate(node=>getComputedStyle(node).borderRadius),touch&&on?'28px':'16px');
  if(touch){
   await toggle.click();await page.waitForFunction(()=>!document.querySelector('[role="switch"]')?.hasAttribute("disabled"));
   await page.reload();await editor.waitFor();
   await page.waitForFunction(()=>typeof(window as any).setTouch==="function");
   await page.evaluate(()=>(window as any).setTouch(true));
   assert.equal(await toggle.getAttribute('aria-checked'),String(!on),'user choice survives reload');
   await page.screenshot({path:`/tmp/newera-entry-${entry}-${mode}.png`});
  }
  assert.deepEqual(errors,[]);await context.close();
 }
 console.log('PASS: 8 standalone/embedded × touch/compact × light/dark entry-default cases; explicit overrides survive reload');
}finally{await browser.close();await vite.close()}
