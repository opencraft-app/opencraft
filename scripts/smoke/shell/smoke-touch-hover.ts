import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";

// Real Home/Composer, production styles and input binding. Forced :hover models
// a browser retaining the old pointer target after the Composer expands.
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/touch-hover";
await mkdir(output, { recursive: true });
const entry = `import {bindTouchInteractionMode} from '/apps/workbench-web/src/runtime/pointer-modality.ts';
bindTouchInteractionMode(document);
import '/tests/fixtures/home-composer-focus.tsx';
import '/packages/chat-render-web/src/renderers/code/code-block.scss';
import '/packages/chat-render-web/src/renderers/table/table.scss';
import '/packages/chat-render-web/src/extensions/mermaid/mermaid.scss';
import '/plugins/tasks/src/styles.scss';`;
const vite = await createServer({configFile:false, root:process.cwd(), cacheDir:"node_modules/.vite-touch-hover", logLevel:"error", esbuild:{jsx:"automatic"}, resolve:{dedupe:["react","react-dom"]},
  // Scan the actual fixture before publishing its dependency graph. The default
  // root HTML scan also reaches unrelated applications and late re-optimization.
  optimizeDeps:{entries:["tests/fixtures/home-composer-focus.tsx"]}, server:{host:"127.0.0.1",port:0,hmr:false}, plugins:[{
  name:"touch-hover-fixture", resolveId:id=>id==="/hover-fixture.tsx"?id:null, load:id=>id==="/hover-fixture.tsx"?entry:null,
  configureServer(server){server.middlewares.use((req,res,next)=>{if(!req.url?.startsWith('/?'))return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/hover-fixture.tsx"></script>');});}
}]});
const engines = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
await vite.listen();
const browser = await engines.chromium.launch({headless:true, executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args:["--no-sandbox"]});
const results: unknown[] = [];
try {
  for (const touch of [false,true]) for (const theme of ["light","dark"]) {
    const context=await browser.newContext({viewport:{width:touch?390:1280,height:844},hasTouch:touch,isMobile:touch});
    const page=await context.newPage();page.setDefaultTimeout(60000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.stack ?? e.message));
    const failedResources: { path: string; status: number }[] = [];
    page.on('response', response => { if (response.status() >= 400) failedResources.push({ path: new URL(response.url()).pathname, status: response.status() }); });
    await page.addInitScript('window.__name=value=>value');
    await page.goto(`${vite.resolvedUrls!.local[0]}?theme=${theme}${touch?'&inline&toolbar':'&desktop&toolbar'}`);
    const editor=page.locator('.opencraft-composer-editor'), model=page.locator('.opencraft-composer-mode--intelligence');
    try { await editor.waitFor(); } catch (error) {
      const startup = { touch, theme, errors, failedResources, body: await page.locator('body').innerText() };
      await writeFile(`${output}/startup-failure.json`, JSON.stringify(startup, null, 2));
      await page.screenshot({ path: `${output}/startup-failure.png` });
      console.error('Touch hover fixture startup failed:', JSON.stringify(startup));
      throw error;
    }
    if(touch)await editor.tap();else await editor.click();await model.waitFor();
    await page.addStyleTag({content:'#negative:hover{background:rgb(255,0,0)}'});
    await page.evaluate(()=>{const b=document.createElement('button');b.id='negative';b.textContent='Hover negative control';document.body.append(b);});
    const session=await context.newCDPSession(page);await session.send('DOM.enable');await session.send('CSS.enable');
    const {root}=await session.send('DOM.getDocument');
    for(const selector of ['#negative','.opencraft-composer-mode--intelligence']) {
      const {nodeId}=await session.send('DOM.querySelector',{nodeId:root.nodeId,selector});
      await session.send('CSS.forcePseudoState',{nodeId,forcedPseudoClasses:['hover']});
    }
    const background=()=>model.evaluate(async el=>{
      // Read the settled paint: the real trigger intentionally transitions for
      // 100ms; an intermediate color is not retained hover.
      await Promise.all(el.getAnimations().map(animation=>animation.finished.catch(()=>{})));
      return getComputedStyle(el).backgroundColor;
    });
    const before=await background();
    for(const pointerType of ['touch','pen']) {
      await page.evaluate(pointerType=>document.dispatchEvent(new PointerEvent('pointerdown',{pointerType,bubbles:true})),pointerType);
      assert.equal(await page.evaluate(()=>document.documentElement.dataset.touchInteraction),'true');
      assert.equal(await background(),'rgba(0, 0, 0, 0)',`${pointerType}: stale hover must be quiet`);
      assert.equal(await page.locator('#negative').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 0, 0)','negative control still has forced hover');
      assert(await editor.evaluate(el=>el===document.activeElement),'suppression cannot blur the editor');
      await page.evaluate(()=>document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',bubbles:true})));
      assert.equal(await background(),before,'real mouse input restores capability-appropriate feedback');
    }
    if(!touch)assert.notEqual(before,'rgba(0, 0, 0, 0)','desktop mouse hover is effective');
    if(touch){await model.tap();await page.locator('[role="menu"]').waitFor();assert.notEqual(await background(),'rgba(0, 0, 0, 0)','touch open state remains visible');await page.keyboard.press('Escape');await page.locator('[role="menu"]').waitFor({state:'hidden'});assert.equal(await background(),'rgba(0, 0, 0, 0)','touch dismissal leaves no hover');}
    await page.screenshot({path:`${output}/${theme}-${touch?'touch':'mouse'}.png`});
    assert.deepEqual(errors,[]);results.push({touch,theme,mouseBackground:before,passed:true});await context.close();
  }
  await writeFile(`${output}/results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify({passed:true,output,cases:results.length}));
} finally {await browser.close();await vite.close();}
