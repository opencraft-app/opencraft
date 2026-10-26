import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");

const source = `
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createComposerController} from '@opencraft/composer-core';
import {OpenCraftComposer} from '@opencraft/composer-editor';
import {WebChatDocument} from '@opencraft/chat-render-web';
import {buildOpenCraftThemeCssProperties,opencraftNeutralThemePalette} from '/packages/design-system/src/theme-engine.ts';
window.setTypographyTheme=mode=>{document.documentElement.dataset.theme=mode;for(const [key,value] of Object.entries(buildOpenCraftThemeCssProperties(mode,opencraftNeutralThemePalette[mode])))document.documentElement.style.setProperty(key,value)};
import {Button} from '/apps/workbench-web/src/components/ui/button.tsx';
import {SettingsPageHeader,SettingsRow,SettingsTextInput} from '@opencraft/extension-react';
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/noto-sans-sc/wght.css';
import '/apps/workbench-web/src/styles/app.scss';
import '/packages/chat-render-web/src/renderers/prose/prose.scss';
import '/packages/chat-render-web/src/renderers/code/code-block.scss';
const controller=createComposerController({type:'new-thread',draftId:'typography',execution:{hostId:'fixture',workspace:{cwd:null,runtimeWorkspaceRoots:[]}}},{now:Date.now,createId:()=>crypto.randomUUID()});
const model={id:'sol',value:'sol',label:'6.1 Sol',description:'中英文模型 / Model',isDefault:true,defaultEffort:'medium',efforts:[{value:'medium',label:'Medium',description:null}]};
const permission={id:'full',value:'full',label:'Full access',mode:'full',description:null,disabled:false};
function TypographyFixture(){
const [codeState,setCodeState]=React.useState({language:'javascript',code:'const value = 1;',open:true,streaming:true});
window.setTypographyCodeState=next=>setCodeState(previous=>({...previous,...next}));
const fence=String.fromCharCode(96).repeat(3);
const codeSource=fence+codeState.language+'\\n'+codeState.code+(codeState.open?'':'\\n'+fence);
return <main style={{padding:16,maxWidth:760}}>
<SettingsPageHeader title='字体语义 / Typography' description='中英文、数字、长标签 English 0123456789'/>
<div style={{display:'flex',gap:8,marginBottom:16}}><Button id='primary'>保存 Save</Button><Button variant='secondary' id='secondary'>取消 Cancel</Button></div>
<SettingsRow label='名称 Name' htmlFor='name'><SettingsTextInput id='name' defaultValue='中英文 Text'/></SettingsRow>
<div className='new-thread-draft-composer-zone'><OpenCraftComposer controller={controller} selectionCatalog={{models:[model],permissionProfiles:[permission]}} effectiveSelections={{model:'sol',effort:'medium',permissionProfile:'full'}} placeholder='输入消息 / Write a message' onSubmit={()=>false} onCancel={()=>{}}/></div>
<article className='opencraft-chat-document' id='reading'><p>阅读正文中文 English 0123456789 <strong>语义强调</strong> <code className='chat-inline-code'>inline_code</code></p><h2>内容标题 Heading</h2><WebChatDocument documentId='typography-code' source={codeSource} streaming={codeState.streaming}/></article>
</main>};
createIntlTestRoot(document.getElementById('root')).render(<TypographyFixture/>);`;

const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-typography",
  esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "typography-fixture", resolveId: id => id === "/typography.tsx" ? id : null,
    load: id => id === "/typography.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== "/") return next();
      res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/typography.tsx"></script>');
    }); } }] });
let browser: any;
const evidence: unknown[] = [];
try {
  await mkdir('.local/typography', {recursive:true}); await vite.listen();
  browser = await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
  const port = (vite.httpServer!.address() as {port:number}).port;
  for (const touch of [false,true]) for (const mode of ['light','dark']) {
    const context=await browser.newContext({viewport:{width:touch?390:1100,height:900},isMobile:touch,hasTouch:touch});
    const page=await context.newPage();const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.addInitScript('window.__name=value=>value');
    await page.goto(`http://127.0.0.1:${port}/`);await page.locator('.opencraft-composer-mode__model-label').waitFor({state:'attached'});
    await page.evaluate(mode=>{(window as any).setTypographyTheme(mode)},mode);
    await page.evaluate(()=>document.fonts.ready);
    const samples=await page.locator('.opencraft-composer-mode__model-label,.opencraft-composer-mode__effort-label,.opencraft-composer-mode__permission-label').evaluateAll(es=>es.map(e=>{let s=getComputedStyle(e);return{selector:e.className,size:s.fontSize,weight:s.fontWeight,line:s.lineHeight,tracking:s.letterSpacing}}));
    assert.equal(samples.length,3);
    assert.ok(samples.every(s=>s.size==='13px'&&s.weight==='400'&&s.line==='18px'&&s.tracking==='normal'),JSON.stringify(samples));
    const editor=await page.locator('.opencraft-composer-editor').evaluate(e=>{let s=getComputedStyle(e);return{size:s.fontSize,line:s.lineHeight,weight:s.fontWeight}});
    assert.equal(editor.size,touch?'16px':'14px');assert.equal(editor.line,touch?'24px':'21px');assert.equal(editor.weight,'400');
    assert.equal(await page.locator('#primary').evaluate(e=>getComputedStyle(e).fontWeight),'500');
    assert.equal(await page.locator('#secondary').evaluate(e=>getComputedStyle(e).fontWeight),'400');
    const reading=await page.locator('#reading').evaluate(e=>{let s=getComputedStyle(e);return{size:s.fontSize,line:s.lineHeight,weight:s.fontWeight}});
    assert.deepEqual(reading,{size:'14px',line:'22px',weight:'400'});
    await page.locator('#reading').evaluate(e=>(e as HTMLElement).style.setProperty('--opencraft-chat-font-size','18px'));
    assert.deepEqual(await page.locator('#reading').evaluate(e=>{const s=getComputedStyle(e);return [s.fontSize,s.lineHeight]}),['18px','26px']);
    assert.equal(await page.locator('#reading .chat-inline-code').evaluate(e=>getComputedStyle(e).fontSize),'18px');
    await page.locator('#reading').evaluate(e=>(e as HTMLElement).style.removeProperty('--opencraft-chat-font-size'));
    await page.locator('.opencraft-composer-mode--intelligence').click();
    await page.locator('.opencraft-composer-model-quick__title').click();
    const menu=await page.locator('.opencraft-composer-selection-menu__item').first().evaluate(e=>{let s=getComputedStyle(e);return{size:s.fontSize,weight:s.fontWeight,line:s.lineHeight}});
    assert.deepEqual(menu,{size:'13px',weight:'400',line:'18px'});
    await page.keyboard.press('Escape');
    await page.locator('.opencraft-composer-selection-menu').waitFor({state:'hidden'});
    const cdp=await context.newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable');const {root}=await cdp.send('DOM.getDocument');const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector:'#primary .ui-button__label'});const fonts=await cdp.send('CSS.getPlatformFontsForNode',{nodeId});
    assert.ok(fonts.fonts.some((f:any)=>f.familyName==='Inter'&&f.isCustomFont));
    await page.locator('#reading').evaluate(e=>(e as HTMLElement).style.setProperty('--opencraft-chat-font-size','18px'));
    const codeSamples=[];
    const codeText='const endpoint = "https://example.com/'+ 'notification/'.repeat(20)+'";\nconsole.log(endpoint);';
    const readCode=()=>page.locator('#reading .chat-code-block__scroller').evaluate(e=>{
      const code=e.querySelector('code')!;
      const walker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);
      const first=walker.nextNode()!;
      const range=document.createRange();range.setStart(first,0);range.setEnd(first,Math.min(5,first.textContent!.length));
      const rect=range.getBoundingClientRect();
      const style=getComputedStyle(e);
      return {size:getComputedStyle(code).fontSize,adjust:style.getPropertyValue('text-size-adjust')||style.getPropertyValue('-webkit-text-size-adjust'),
        tokenSizes:[...new Set([...code.querySelectorAll('span')].map(token=>getComputedStyle(token).fontSize))],
        text:code.textContent,glyph:{width:rect.width,height:rect.height},client:e.clientWidth,scroll:e.scrollWidth};
    });
    for(const language of ['javascript','bash','']){
      await page.evaluate(({language,code})=>(window as any).setTypographyCodeState({language,code,open:true,streaming:true}),{language,code:codeText});
      await page.locator('#reading .chat-code-block[data-code-open="true"]').waitFor();
      const original=await page.locator('#reading .chat-code-block code').elementHandle();
      const open=await readCode();
      assert.equal(open.size,'18px');assert.equal(open.adjust,'100%');assert.equal(open.text,codeText);
      assert.ok(open.scroll>open.client,'long lines remain horizontally scrollable');
      await page.evaluate(()=>(window as any).setTypographyCodeState({open:false,streaming:false}));
      await page.locator('#reading code.chat-code-highlight span').first().waitFor();
      const highlighted=await readCode();
      assert.equal(highlighted.size,'18px');assert.equal(highlighted.adjust,'100%');assert.equal(highlighted.text,codeText);
      assert.deepEqual(highlighted.tokenSizes,['18px']);assert.deepEqual(highlighted.glyph,open.glyph);
      assert.ok(await original!.evaluate(e=>e.isConnected),'highlighting retains the selected code element');
      await page.getByRole('button',{name:'Enable word wrap',exact:true}).click();
      const wrapped=await readCode();assert.equal(wrapped.size,'18px');assert.equal(wrapped.adjust,'100%');assert.ok(wrapped.scroll<=wrapped.client+1);
      await page.getByRole('button',{name:'Disable word wrap',exact:true}).click();
      codeSamples.push({language,open,highlighted,wrapped});
    }
    await page.locator('#reading').evaluate(e=>(e as HTMLElement).style.removeProperty('--opencraft-chat-font-size'));
    assert.equal((await readCode()).size,'14px','code continues to follow the reading-size preference');
    assert.deepEqual(errors,[]);
    await page.screenshot({path:`.local/typography/${touch?'mobile':'desktop'}-${mode}.png`,fullPage:true});
    evidence.push({touch,mode,samples,editor,reading,codeSamples,menu,fonts});await context.close();
  }
  await writeFile('.local/typography/browser.json',JSON.stringify(evidence,null,2));
  console.log('Typography: actual composer, buttons, Settings controls and document-style samples passed desktop/mobile light/dark; bundled Inter confirmed.');
} finally {await browser?.close();await vite.close();}
