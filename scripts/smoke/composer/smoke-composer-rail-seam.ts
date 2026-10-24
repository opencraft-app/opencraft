import assert from "node:assert/strict";
import { createServer } from "vite";
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:"error",esbuild:{jsx:"automatic"},resolve:{dedupe:["react","react-dom"]},server:{host:"127.0.0.1",port:0},plugins:[{name:"entry-defaults",configureServer(server){server.middlewares.use((req,res,next)=>{if(!req.url?.startsWith("/?"))return next();res.setHeader("content-type","text/html");res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/touch-newera.tsx"></script>')})}}]});
const playwright=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??"playwright");
const {chromium}=playwright.default??playwright;
await vite.listen();const browser=await chromium.launch({executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:["--no-sandbox"]});
try {
 const quick=process.argv.includes("--quick");
 for(const dpr of quick?[2]:[1,2,3]) for(const palette of quick?["neutral"]:["neutral","frost"]) for(const mode of quick?["light"]:["light","dark"]) for(const variant of quick?["newera"]:["newera","off","desktop"]){
  const context=await browser.newContext({viewport:{width:variant==="desktop"?1280:390,height:844},hasTouch:variant!=="desktop",deviceScaleFactor:dpr});
  const page=await context.newPage();const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.addInitScript("window.__name=value=>value");
  await page.goto(`${vite.resolvedUrls!.local[0]}?palette=${palette}&mode=${mode}`);
  await page.waitForFunction(()=>typeof(window as any).setTouch==="function");
  await page.evaluate(()=>{document.documentElement.dataset.timelineTracksVisualViewport="true";document.documentElement.style.setProperty("--timeline-visual-viewport-height","500px")});
  await page.evaluate(async variant=>{await(window as any).setTouch(variant!=="desktop");await(window as any).setNewera(variant==="newera");await(window as any).setQueue(true)},variant);
  const rail=page.locator('.opencraft-composer-attached-rail'),shell=page.locator('.opencraft-composer-shell'),editor=page.locator('.opencraft-composer-editor');
  await page.locator('.opencraft-composer-queue-item').waitFor();
  const originalEditor=await editor.elementHandle();
  for(const state of ["idle","focused","draft"]){
   if(state==="focused")await editor.click();
   if(state==="draft")await editor.fill("保留草稿与队列");
   await page.waitForTimeout(220);
   const geometry=await rail.evaluate((rail:HTMLElement)=>{
    const shell=rail.nextElementSibling as HTMLElement,r=rail.getBoundingClientRect(),e=shell.getBoundingClientRect(),s=getComputedStyle(shell),p=getComputedStyle(shell,"::before");
    const railPaintBottom=r.bottom-parseFloat(getComputedStyle(rail).paddingBottom)+parseFloat(getComputedStyle(rail).getPropertyValue("--coverage-composer-material-seam"));
    const editorPaintTop=e.top+parseFloat(s.borderTopWidth)+parseFloat(p.top);
    return{topBorder:s.borderTopColor,highlight:s.getPropertyValue("--composer-seam-highlight").trim(),paintGap:editorPaintTop-railPaintBottom,left:r.left-e.left,right:e.right-r.right,overlap:r.bottom-e.top,corner:parseFloat(s.borderTopLeftRadius),endCorner:parseFloat(s.borderTopRightRadius),bottom:parseFloat(s.borderBottomLeftRadius),materialCorner:parseFloat(p.borderTopLeftRadius),filter:getComputedStyle(rail,"::before").backdropFilter};
   });
   assert.equal(geometry.topBorder,"rgba(0, 0, 0, 0)","internal seam has no second outline");assert.equal(geometry.highlight,"transparent");
   assert(geometry.paintGap>=-1,"material coverage must stay within the seam, not the full tuck");
   assert(geometry.paintGap<=0,"painted materials leave an uncovered seam: "+JSON.stringify(geometry));
   assert.equal(geometry.corner,geometry.bottom,"editor corners remain symmetric with attachments");assert.equal(geometry.endCorner,geometry.bottom);
   assert.equal(geometry.materialCorner,geometry.corner);assert.equal(geometry.overlap,geometry.corner);assert.equal(geometry.bottom,variant==="newera"?28:16);assert.match(geometry.filter,/blur/);
   assert(await editor.evaluate((el,original)=>el===original,originalEditor),"same editable DOM");
   if(state==="idle" && variant==="newera" && dpr===2){
    // Probe actual paint coverage against a contrasting backdrop, including the
    // border box. Geometry alone previously missed this one-pixel hairline.
    const probe=await page.addStyleTag({content:`main,[aria-hidden]{background:black !important} .opencraft-composer-shell > *{visibility:hidden !important} .opencraft-composer-shell{border-color:transparent !important;box-shadow:none !important}.opencraft-composer-shell::before,.opencraft-composer-attached-rail::before{background:rgb(255,0,80) !important;backdrop-filter:none !important}`});
    const bounds=await shell.boundingBox();const railBounds=await rail.boundingBox();
    const readGapPixels=async()=>{
     const png=await page.screenshot({clip:{x:Math.ceil(railBounds!.x)+2,y:Math.floor(bounds!.y)-1,width:Math.floor(railBounds!.width)-4,height:10}});
     return page.evaluate(async src=>{const img=new Image();img.src=src;await img.decode();const canvas=document.createElement("canvas");canvas.width=img.width;canvas.height=img.height;const ctx=canvas.getContext("2d")!;ctx.drawImage(img,0,0);const pixels=ctx.getImageData(0,0,img.width,img.height).data;let gaps=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]<240||pixels[i+1]>5||pixels[i+2]<70)gaps++;return gaps},`data:image/png;base64,${png.toString("base64")}`);
    };
    await rail.evaluate(el=>(el as HTMLElement).style.setProperty("--coverage-composer-material-seam","0px"));
    assert(await readGapPixels()>0,"old material cut must expose the contrasting backdrop");
    await rail.evaluate(el=>(el as HTMLElement).style.removeProperty("--coverage-composer-material-seam"));
    const uncovered=await readGapPixels();
    if(uncovered) await page.screenshot({path:"/tmp/symmetric-paint.png",clip:{x:Math.ceil(railBounds!.x)+2,y:Math.floor(bounds!.y)-1,width:Math.floor(railBounds!.width)-4,height:10}});
    assert.equal(uncovered,0,"no uncovered pixels across the attached seam");
    await probe.evaluate(el=>el.remove());
   }
   if(state==="idle"){

   }
   if(variant==="newera")await page.locator('.opencraft-composer-stack').screenshot({animations:"disabled",path:`/tmp/rail-seam-${palette}-${mode}-${state}-dpr${dpr}.png`});
  }
  await page.evaluate(()=>(window as any).setQueue(false));await rail.waitFor({state:'hidden'});
  assert.equal(await shell.evaluate(el=>getComputedStyle(el).borderTopLeftRadius),variant==="newera"?"28px":"16px");
  assert.equal(await editor.innerText(),"保留草稿与队列");assert.deepEqual(errors,[]);await context.close();
 }
 console.log(`PASS: ${quick?1:36} DPR/theme/layout cases × idle/focused/draft; seam contour, symmetric capsule and contour-matched rail/material, same editor/draft and empty restoration; legacy material cut negative control`);
}finally{await browser.close();await vite.close()}
