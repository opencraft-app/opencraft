import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "vite";
import { createWorkbenchWebConfig } from "../../../apps/workbench-web/vite.config";
const { chromium } = await import("playwright");
const output = resolve(process.env.OPENCRAFT_PRESENTATION_REPORT ?? "/tmp/opencraft-presentation-policy");
const explicitOptions = {
  iconStyle: "classic" as const,
  defaultThemeId: "opencraft.core.canvas",
  hiddenBuiltinThemeIds: ["opencraft.core.mist"],
};
await mkdir(output, {recursive: true});
const evidence: unknown[] = [];
const browser = await chromium.launch({headless: true});
try {
  for (const product of [false, true]) {
    // Product identity alone must not select a presentation policy.
    // Standard defaults apply unless the trusted build supplies explicit policy.
    process.env.OPENCRAFT_PRODUCT = product ? "unrelated-identity" : "example-web";
    process.env.OPENCRAFT_BUILD_TARGET = "web";
    const config = createWorkbenchWebConfig({mode:"development",command:"serve"}, {
      hyperNode:false,builtinAgents:false,tasks:false,pluginBranding:false,
      presentation: product ? explicitOptions : undefined,
    });
    const source = `
import React from 'react';import{createRoot}from'react-dom/client';
import{WorkbenchIcon}from'/apps/workbench-web/src/components/ui/workbench-icon.tsx';
import{NavigationIcon}from'/apps/workbench-web/src/components/shell-navigation/navigation-action.tsx';
import{NewTaskIcon}from'/apps/workbench-web/src/chrome-actions/new-task-icon.tsx';
import{WorkbenchPresentationContext,workbenchPresentation,applyWorkbenchProductPresentation}from'/apps/workbench-web/src/workbench-product';
import{resolveWorkbenchPresentation}from'/apps/workbench-web/src/workbench-presentation';
import{initializeAppearanceTheme,getAppearanceThemeSnapshot,setAppearanceThemeId,setThemePreference}from'/apps/workbench-web/src/appearance-theme';
import'/apps/workbench-web/src/styles/app.scss';
const explicitPolicy=resolveWorkbenchPresentation(${JSON.stringify(explicitOptions)});
initializeAppearanceTheme();
const host=document.createElement('section');document.body.append(host);const shadow=host.attachShadow({mode:'open'});const slot=document.createElement('div');shadow.append(slot);applyWorkbenchProductPresentation(host,'another-identity',explicitPolicy);
const glyphs=<><WorkbenchIcon name='appearance'/><NavigationIcon name='settings' selected/><NewTaskIcon/></>;
createRoot(slot).render(<WorkbenchPresentationContext.Provider value={explicitPolicy}>{glyphs}</WorkbenchPresentationContext.Provider>);
createRoot(document.getElementById('root')).render(<main><h1>Presentation policy</h1><div id='glyphs'>{glyphs}</div><nav className='settings-page__navigation'><button id='navigation-glyph'><NavigationIcon name='updates' selected/></button></nav><textarea aria-label='Draft' defaultValue='Preserved draft'/></main>);
window.proof={getAppearanceThemeSnapshot,setAppearanceThemeId,setThemePreference,workbenchPresentation,host,slot};`;
    const server = await createServer({...config,configFile:false,root:process.cwd(),logLevel:"error",
      cacheDir:"node_modules/.vite-presentation-proof",server:{host:"127.0.0.1",port:0,hmr:false},
      plugins:[...(config.plugins ?? []),{name:"presentation-proof",resolveId:id=>id==="/presentation-proof.tsx"?id:null,
        load:id=>id==="/presentation-proof.tsx"?source:null,configureServer(s){s.middlewares.use((req,res,next)=>{
          if(req.url!=="/")return next();res.setHeader("content-type","text/html");res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/presentation-proof.tsx"></script>');
        });}}]});
    try {
      await server.listen();const url=`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}`;
      const priority=await browser.newPage();
      await priority.addInitScript(()=>{if(localStorage.getItem('opencraft.appearance-theme')!==null)return;localStorage.setItem('opencraft.appearance-theme','light');localStorage.setItem('opencraft.appearance-theme-id','opencraft.core.lavender')});
      await priority.goto(url);await priority.locator('#glyphs svg').first().waitFor();
      let preferred=await priority.evaluate(()=>(window as any).proof.getAppearanceThemeSnapshot());
      assert.equal(preferred.preference,'light');assert.equal(preferred.themeId,'opencraft.core.lavender');
      await priority.evaluate(()=>localStorage.setItem('opencraft.appearance-theme-id','vendor.paper'));
      await priority.reload();await priority.locator('#glyphs svg').first().waitFor();
      preferred=await priority.evaluate(()=>(window as any).proof.getAppearanceThemeSnapshot());
      assert.equal(preferred.requestedThemeId,'vendor.paper');assert.equal(preferred.themeId,product?'opencraft.core.canvas':'opencraft.core.neutral');
      evidence.push({product,canonicalSelection:true,opaqueExtensionId:true});await priority.close();
      for (const width of [1100,390]) {
        const page=await browser.newPage({viewport:{width,height:800}});const errors:string[]=[];
        page.on('pageerror',error=>errors.push(error.message));
        await page.goto(url);await page.locator('#glyphs svg').first().waitFor();
        const initial=await page.evaluate(()=>{const p=(window as any).proof;return{policy:p.workbenchPresentation,snapshot:p.getAppearanceThemeSnapshot(),glyph:document.querySelector('#glyphs svg')!.getAttribute('data-action-glyph'),shadowGlyph:p.slot.querySelector('svg').getAttribute('data-action-glyph'),shadowSize:p.host.style.getPropertyValue('--size-product-navigation-icon')}});
        assert.equal(initial.policy.iconStyle,product?'classic':'standard');
        assert.equal(initial.snapshot.themeId,product?'opencraft.core.canvas':'opencraft.core.neutral');
        assert.equal(initial.snapshot.availableThemes.some((t:any)=>t.id==='opencraft.core.mist'),!product);
        assert.equal(initial.glyph,product?'palette':'appearance');
        assert.equal(initial.shadowGlyph,'palette');assert.equal(initial.shadowSize,'auto');
        const stroke = await page.locator('#navigation-glyph svg').evaluate(svg=>getComputedStyle(svg).strokeWidth);
        assert.equal(stroke,product?'2.5px':'2px');
        // Changing only identity cannot change icon presentation or its stroke.
        await page.evaluate(()=>{document.documentElement.dataset.workbenchProduct='unrelated-product';});
        assert.equal(await page.locator('#navigation-glyph svg').evaluate(svg=>getComputedStyle(svg).strokeWidth),stroke);
        for(const mode of ['light','dark']) {
          await page.evaluate(mode=>(window as any).proof.setThemePreference(mode),mode);
          await page.getByRole('textbox',{name:'Draft'}).fill('Draft survives theme selection');
          await page.evaluate(()=>(window as any).proof.setAppearanceThemeId('opencraft.core.lavender'));
          assert.equal(await page.getByRole('textbox',{name:'Draft'}).inputValue(),'Draft survives theme selection');
          assert.equal(await page.locator('html').getAttribute('data-theme'),mode);
          await page.screenshot({path:join(output,`${product?'product':'core'}-${width}-${mode}.png`)});
          // Reload through the real entry with existing storage: defaults must
          // not replace either saved light/dark preference or selected palette.
          await page.reload();await page.locator('#glyphs svg').first().waitFor();
          const saved=await page.evaluate(()=>(window as any).proof.getAppearanceThemeSnapshot());
          assert.equal(saved.themeId,'opencraft.core.lavender');assert.equal(saved.preference,mode);
        }
        assert.deepEqual(errors,[]);evidence.push({product,width,initial,savedReload:true,errors});await page.close();
      }
    } finally {await server.close();}
  }
  await writeFile(join(output,'verification.json'),JSON.stringify({verified:true,evidence},null,2));
} finally {await browser.close();}
console.log(`Presentation policy verified: ${output}`);
