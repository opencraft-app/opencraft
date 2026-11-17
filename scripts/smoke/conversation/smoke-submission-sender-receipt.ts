import assert from "node:assert/strict";
import { createServer } from "vite";

// Run with an installed Playwright module and Chrome/Chromium binary; use
// OPENCRAFT_PLAYWRIGHT_MODULE and OPENCRAFT_CHROMIUM_EXECUTABLE when external.
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-submission-sender-receipt-smoke",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "submission-sender-receipt-smoke",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== "/") return next();
        response.setHeader("content-type", "text/html");
        response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="host"></div><script type="module" src="/tests/fixtures/submission-sender-receipt.tsx"></script></body></html>');
      });
    },
  }],
});

let browser;
try {
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  for (const touch of [false,true]) {
    const context=await browser.newContext({viewport:{width:touch?390:1200,height:900},hasTouch:touch,isMobile:touch});
    const page=await context.newPage();const errors:string[]=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as {port:number}).port}`);
    assert.equal(await page.evaluate(()=>innerWidth),touch?390:1200);
    const name=page.locator("#host .thread-user-message__sender");
    const waitSender=(expected:string|null)=>page.waitForFunction(expected=>{
      const label=document.getElementById("host")?.shadowRoot?.querySelector(".thread-user-message__sender");
      return expected===null?!label:label?.textContent===expected;
    },expected);
    await waitSender("verified-author");
    await page.locator("#host .thread-user-message__bubble").filter({hasText:"Accepted input before native echo"}).waitFor();
    assert.equal(await name.textContent(),"verified-author");
    await page.evaluate(()=> (window as any).paintReceipt(null));
    await waitSender(null);
    assert.equal(await name.count(),0,"verified anonymous receipt overrides the local fallback");
    await page.evaluate(()=> (window as any).paintReceipt(undefined));
    await name.filter({hasText:"legacy-fallback"}).waitFor();
    await waitSender("legacy-fallback");
    assert.equal(await name.textContent(),"legacy-fallback","older peers retain the fallback");
    await page.evaluate(()=> (window as any).paintReceipt({kind:"employee",loginName:"verified-author"}));
    await name.filter({hasText:"verified-author"}).waitFor();
    await waitSender("verified-author");
    assert.equal(await name.textContent(),"verified-author");
    const labelBox=await name.boundingBox(),bubbleBox=await page.locator("#host .thread-user-message__bubble").boundingBox();
    assert.ok(labelBox&&bubbleBox&&labelBox.y+labelBox.height<=bubbleBox.y,"receipt author stays above its actual message");
    await page.screenshot({path:(process.env.OPENCRAFT_RECEIPT_ARTIFACT_DIR??"/tmp")+`/submission-receipt-${touch?"touch":"desktop"}.png`});
    await page.evaluate(()=> (window as any).paintReceipt({kind:"employee",loginName:"verified-author"},true));
    await name.waitFor({state:"detached"});
    await waitSender(null);
    assert.equal(await name.count(),0,"canonical anonymous echo supersedes the temporary receipt sender");
    assert.deepEqual(errors,[]);await context.close();
  }
  console.log("PASS: actual UserMessageBlock consumes verified, anonymous and legacy receipt display on desktop and touch; canonical echo wins");

} finally {
  await browser?.close();
  await vite.close();
}
