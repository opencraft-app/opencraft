import assert from 'node:assert/strict';
import {createServer} from 'vite';
const pw=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');const {chromium}=pw.default??pw;
const source=`import React,{useState} from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {AsyncNoticesProvider} from '/apps/workbench-web/src/components/async-notices.tsx';
import {EditableThreadTitle} from '/apps/workbench-web/src/components/editable-thread-title.tsx';
import {initializeAppearanceTheme} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();window.calls=[];window.fail=false;
function App(){const [title,setTitle]=useState('A long conversation title 用得不爽直接来这改'.repeat(3));return <AsyncNoticesProvider><div className='thread-header-title' style={{width:'100%',height:56}}><EditableThreadTitle title={title} project='data' onRename={async value=>{window.calls.push(value);if(window.fail)throw Error('fixture');setTitle(value)}}/></div></AsyncNoticesProvider>}
createIntlTestRoot(document.getElementById('root')).render(<App/>);`;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0},plugins:[{name:'fixture',resolveId:id=>id==='/probe.tsx'?id:null,load:id=>id==='/probe.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/probe.tsx"></script>')})}}]});
let browser;
try{await vite.listen();browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});for(const touch of [false,true])for(const theme of ['light','dark']){
const context=await browser.newContext({viewport:{width:touch?390:1000,height:800},hasTouch:touch,isMobile:touch});const page=await context.newPage();await page.addInitScript('window.__name=v=>v');await page.goto(vite.resolvedUrls!.local[0]!);const button=page.getByRole('button',{name:'Rename',exact:true});await button.waitFor();await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
const box=await button.boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=(touch?390:1000));if(touch)assert.ok(box!.width>=44&&box!.height>=44);
await page.screenshot({path:'/tmp/title-rename-'+touch+'-'+theme+'.png'});await button.click();const input=page.getByRole('textbox',{name:'Conversation name'});await input.fill('Cancelled');await input.press('Escape');assert.equal(await page.evaluate('window.calls.length'),0);await button.click();await input.fill('Renamed');await input.press('Enter');await page.getByText('Renamed',{exact:true}).waitFor();await button.click();await input.fill('Failed');await page.evaluate('window.fail=true');await input.press('Enter');await page.getByText('Could not rename the conversation. Try again.',{exact:true}).waitFor();assert.equal(await page.locator('.thread-header-edit__error').count(),0);await input.press('Escape');await context.close();}console.log('PASS desktop/touch light/dark: pencil geometry, rename, cancel, toast failure');}finally{await browser?.close();await vite.close()}
