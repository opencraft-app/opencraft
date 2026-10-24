import assert from "node:assert/strict";
import { createServer } from "vite";
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:"error",esbuild:{jsx:"automatic"},resolve:{dedupe:["react","react-dom"]},server:{host:"127.0.0.1",port:0},plugins:[{name:"entry-defaults",configureServer(server){server.middlewares.use((req,res,next)=>{if(!req.url?.startsWith("/?"))return next();res.setHeader("content-type","text/html");res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/touch-newera.tsx"></script>')})}}]});
const playwright=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??"playwright");
const {chromium}=playwright.default??playwright;
await vite.listen();const browser=await chromium.launch({executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:["--no-sandbox"]});
try {
 for(const palette of ["neutral","canvas","frost","lavender","mist","graphite"]) for(const mode of ["light","dark"]) for(const variant of ["newera","off","desktop"]){
  const context=await browser.newContext({viewport:{width:variant==="desktop"?1280:390,height:844},hasTouch:variant!=="desktop"});
  const page=await context.newPage();const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.addInitScript("window.__name=value=>value");
  await page.goto(`${vite.resolvedUrls!.local[0]}?scrollControl=1&palette=${palette}&mode=${mode}`);
  await page.waitForFunction(()=>typeof(window as any).setTouch==="function");
  await page.evaluate(async variant=>{await(window as any).setTouch(variant!=="desktop");await(window as any).setNewera(variant!=="off");},variant);
  const button=page.getByRole("button",{name:"回到底部"});await button.waitFor();
  const before=await button.boundingBox();assert(before);assert.equal(before.width,variant==="newera"?44:32);assert.equal(before.height,before.width);
  const styles=await button.evaluate(el=>{const s=getComputedStyle(el);const icon=getComputedStyle(el.querySelector("svg")!);return{bg:s.backgroundColor,filter:s.backdropFilter,icon:icon.width,stroke:icon.strokeWidth}});
  assert.equal(styles.icon,variant==="newera"?"23px":"20px");
  if(variant==="newera"){
   assert.match(styles.filter,/blur\(20px\)/);assert.match(styles.bg,/0\.62/);assert.equal(styles.stroke,"0.35px");
   assert.equal(await button.evaluate(el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.left+1,r.top+1)===el}),false,"circle corners do not capture touch");
  }else{assert.equal(styles.filter,"none");}
  await button.click();assert.equal(await page.evaluate(()=>(window as any).scrollClicks),1);
  await page.evaluate(()=>(window as any).setWorking(true));await button.locator("i").first().waitFor();
  assert.deepEqual(await button.boundingBox(),before,"working dots preserve geometry");
  await button.click();assert.equal(await page.evaluate(()=>(window as any).scrollClicks),2);
  await button.focus();await page.keyboard.press("Enter");assert.equal(await page.evaluate(()=>(window as any).scrollClicks),3);
  if(variant==="newera"){
   await button.evaluate(el=>(el as HTMLElement).blur());
   const dot=await button.locator("i").first().evaluate(el=>parseFloat(getComputedStyle(el).width));assert(Math.abs(dot-4.6)<0.02);
   await page.screenshot({animations:"disabled",path:`/tmp/newera-scroll-${palette}-${mode}.png`});
   await page.evaluate(()=>(window as any).setWorking(false));await button.locator("svg").waitFor();
   await page.screenshot({animations:"disabled",path:`/tmp/newera-scroll-${palette}-${mode}-arrow.png`});
   await page.emulateMedia({forcedColors:"active",reducedMotion:"reduce"});
   assert.equal(await button.evaluate(el=>getComputedStyle(el).backdropFilter),"none");
   await page.evaluate(()=>(window as any).setWorking(true));await button.locator("i").first().waitFor();
   assert.equal(await button.locator("i").first().evaluate(el=>getComputedStyle(el).animationName),"none");
   await page.emulateMedia({forcedColors:"none"});
   const cdp=await context.newCDPSession(page);await cdp.send("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-transparency",value:"reduce"}]});
   assert.equal(await button.evaluate(el=>getComputedStyle(el).backdropFilter),"none");
  }
  assert.deepEqual(errors,[]);await context.close();
 }
 console.log('PASS: 36 real control cases; arrow/dots, click/keyboard, stable geometry, touch/desktop, themes and accessibility');
}finally{await browser.close();await vite.close()}
