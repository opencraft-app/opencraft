import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Actual Page runtime + notification bridge/provider. Only the physical surface
// boundary is replaced. Native IME/OS keyboard are separate verification scopes.
const source = `import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {BrowserInputNotices} from '/apps/workbench-web/src/browser/browser-input-notices.tsx';
import {WebBrowserPageRuntime} from '/apps/workbench-web/src/browser/web-browser-runtime.ts';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();setThemePreference(new URLSearchParams(location.search).get('theme')||'light');
function fixture(label){let events;let navigations=0;const surface={navigate(_id,_title,_url,port){events=port;navigations++;return false;},close(){},forget(){}};
const pages=new WebBrowserPageRuntime(surface,null,()=>null,{getItem:()=>null,setItem(){}});
const page=pages.create({ownerId:label,initialUrl:'https://example.test/'});pages.prepareSurface(page);events.onLoaded('Fixture');
let subscriptions=0;const subscribe=pages.onInputError.bind(pages);pages.onInputError=listener=>{subscriptions++;const remove=subscribe(listener);return()=>{subscriptions--;remove()}};
return {pages,page,events,subscriptions:()=>subscriptions,navigations:()=>navigations};}
const a=fixture('A'),b=fixture('B');window.probe={a,b};
const rootA=createIntlTestRoot(document.getElementById('app-a'),undefined,'en-US');
const rootB=createIntlTestRoot(document.getElementById('app-b'),undefined,'zh-CN');
rootA.render(React.createElement(React.Fragment,null,React.createElement(BrowserInputNotices,{pages:a.pages}),React.createElement('section',null,React.createElement('label',null,'Draft A',React.createElement('input',{'aria-label':'Draft A'})),React.createElement('p',null,'Second view of the same Page'))));
rootB.render(React.createElement(React.Fragment,null,React.createElement(BrowserInputNotices,{pages:b.pages}),React.createElement('section',null,React.createElement('label',null,'Draft B',React.createElement('input',{'aria-label':'Draft B'})))));
window.probe.unmountA=()=>rootA.unmount();`;
const output=await mkdtemp(join(tmpdir(),'opencraft-browser-input-feedback-'));
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom']},optimizeDeps:{include:['react','react-dom/client','react/jsx-runtime','sonner'],force:true},cacheDir:'node_modules/.vite-browser-input-feedback',esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0},plugins:[{
  name:'browser-input-feedback-fixture',
  configureServer(server){server.middlewares.use((req,res,next)=>{
    if(req.url!=='/'&&!req.url?.startsWith('/?'))return next();
    res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="app-a"></div><div id="app-b"></div><script type="module" src="/__browser_input_feedback.tsx"></script>');
  });},
  resolveId(id){if(id==='/__browser_input_feedback.tsx')return '\0browser-input-feedback.tsx';},
  load(id){if(id==='\0browser-input-feedback.tsx')return source;},
}]});
let browser;const results:any[]=[];
try{
  await vite.listen();browser=await chromium.launch({headless:true,args:process.getuid?.()===0?['--no-sandbox']:[]});
  for(const touch of [false,true])for(const theme of ['light','dark']){
    const page=await browser.newPage({viewport:{width:touch?390:1100,height:850},hasTouch:touch,isMobile:touch,deviceScaleFactor:touch?2:1});
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port+'/?theme='+theme);
    await page.waitForFunction(()=>{const p=(window as any).probe;return p?.a.subscriptions()===1&&p?.b.subscriptions()===1;});
    await page.evaluate(()=>document.fonts.ready);
    const draft=page.getByRole('textbox',{name:'Draft A',exact:true});
    if(touch)await draft.tap();else await draft.click();await page.keyboard.type('draft-value');
    const before=await draft.boundingBox();
    await page.evaluate(()=>{const p=(window as any).probe;for(let i=0;i<10;i++)p.a.events.onInputError('focus');});
    await page.getByText('Focus the text field and try again.',{exact:true}).waitFor();
    const toasts=page.locator('[data-sonner-toast]:not([data-removed=true])');
    await page.waitForFunction(()=>[...document.querySelectorAll('[data-sonner-toast]:not([data-removed=true])')].every(el=>getComputedStyle(el).opacity==='1'&&el.getAttribute('data-mounted')==='true'));
    const noticeStyle=await toasts.first().evaluate(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return {color:s.color,background:s.backgroundColor,opacity:s.opacity,left:r.left,right:r.right,viewport:innerWidth};});
    assert.notEqual(noticeStyle.color,noticeStyle.background);assert.notEqual(noticeStyle.background,'rgba(0, 0, 0, 0)');
    assert(noticeStyle.left>=0&&noticeStyle.right<=noticeStyle.viewport);

    assert.equal(await toasts.count(),1,'repeated per-Page feedback is deduplicated');
    assert.equal(await page.getByText('请重新点选输入框后再试。',{exact:true}).count(),0,'other application does not receive the event');
    assert.equal(await draft.inputValue(),'draft-value');assert.equal(await draft.evaluate(el=>el===document.activeElement),true);
    assert.deepEqual(await draft.boundingBox(),before,'notice does not reflow the editor');
    const snapshot=await page.evaluate(()=>{const p=(window as any).probe;return {a:p.a.pages.getSnapshot(p.a.page),b:p.b.pages.getSnapshot(p.b.page),navigations:p.a.navigations()};});
    assert.equal(snapshot.a.error,null);assert.equal(snapshot.b.error,null);assert.equal(snapshot.navigations,1);
    const screenshot=join(output,(touch?'touch':'mouse')+'-'+theme+'.png');await page.screenshot({path:screenshot});
    await page.evaluate(()=>{(window as any).probe.b.events.onInputError('copy');});
    await page.getByText('复制失败，请重试。',{exact:true}).waitFor();assert.equal(await toasts.count(),2);
    await page.evaluate(()=>{const p=(window as any).probe;p.a.pages.close(p.a.page);p.a.events.onInputError('edit');});
    assert.equal(await page.getByText('Could not enter text. Focus the field and try again.',{exact:true}).count(),0);
    await page.evaluate(()=>{(window as any).probe.unmountA();});
    await page.waitForFunction(()=>(window as any).probe.a.subscriptions()===0);
    await page.evaluate(()=>{(window as any).probe.a.events.onInputError('focus');});
    assert.equal(await page.getByText('Focus the text field and try again.',{exact:true}).count(),0);
    assert.equal(await page.getByText('复制失败，请重试。',{exact:true}).count(),1);
    assert.equal(await page.evaluate(()=>(window as any).probe.b.subscriptions()),1);
    assert.deepEqual(errors,[]);results.push({touch,theme,isolatedRoots:true,deduplicated:true,preservedFocusAndDraft:true,noPageError:true,noReload:true,noticeStyle,screenshot,errors});
    await page.close();
  }
  await writeFile(join(output,'result.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({output,results}));
}finally{await browser?.close();await vite.close();}
