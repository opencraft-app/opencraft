import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "vite";
const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output=process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/generated-image-history";
mkdirSync(output,{recursive:true});
// Optional real generated image; the default is a small valid PNG, not real user data.
const png=process.env.OPENCRAFT_IMAGE_SAMPLE ? readFileSync(process.env.OPENCRAFT_IMAGE_SAMPLE)
  :Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==","base64");
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:"error",esbuild:{jsx:"automatic"},
  resolve:{dedupe:["react","react-dom"]},cacheDir:"node_modules/.vite-generated-image-history",server:{host:"127.0.0.1",port:0},
  plugins:[{name:"generated-image-history",configureServer(server){server.middlewares.use((req,res,next)=>{
    if(req.url==="/fixture-image"){res.setHeader("content-type","image/png");res.end(png);return;}
    if(!req.url?.startsWith("/?")&&req.url!=="/")return next();
    res.setHeader("content-type","text/html");res.end('<div id="root"></div><script type="module" src="/tests/fixtures/generated-image-history.tsx"></script>');
  });}}]});
let browser;
try {
  await vite.listen();browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
  const origin=`http://127.0.0.1:${(vite.httpServer!.address() as {port:number}).port}`;
  for(const touch of [false,true]) for(const theme of ["light","dark"]) {
    const page=await browser.newPage({viewport:touch?{width:390,height:844}:{width:1100,height:800},hasTouch:touch,isMobile:touch});
    const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
    await page.goto(`${origin}/?theme=${theme}`);
    const img=page.locator('[data-testid="generated-image-preview"] img');
    const ready=()=>page.waitForFunction(()=>{const i=document.querySelector<HTMLImageElement>('[data-testid="generated-image-preview"] img');return i!==null&&i.naturalWidth>0;});
    await ready();assert.match(await img.getAttribute("src") ?? "",/^blob:/);
    assert.equal(await page.evaluate(()=>(window as any).imageHistory.requests),1);
    await page.screenshot({path:`${output}/${touch?"touch":"desktop"}-${theme}.png`});
    // An old invalid inline image falls back to its original file exactly once.
    await page.evaluate(()=>{(window as any).imageHistory.set({uri:"data:image/png;base64,aW52YWxpZA=="});});
    await page.waitForFunction(()=>(window as any).imageHistory.requests===2);await ready();
    await page.getByTestId("generated-image-preview").click();await page.getByRole("dialog").waitFor();
    assert.ok(await page.getByRole("link",{name:"Save"}).getAttribute("href"));
    await page.getByRole("button",{name:"Close generated image 1"}).click();
    // Both sources fail: no broken img remains, and retry reloads the file.
    await page.evaluate(()=>{const p=(window as any).imageHistory;p.failFiles=true;p.set({id:"failure",uri:"data:image/png;base64,YmFk"});});
    await page.getByRole("button",{name:"Try again"}).waitFor();assert.equal(await img.count(),0);
    await page.screenshot({path:`${output}/${touch?"touch":"desktop"}-${theme}-unavailable.png`});
    await page.evaluate(()=>(window as any).imageHistory.failFiles=false);
    await page.getByRole("button",{name:"Try again"}).click();await ready();
    assert.equal(await page.evaluate(()=>(window as any).imageHistory.requests),4);
    assert.deepEqual(errors,[]);await page.close();
  }
  console.log("Generated image file load, inline fallback, preview, unavailable and retry passed in desktop/touch × light/dark.");
}finally{await browser?.close();await vite.close();}
