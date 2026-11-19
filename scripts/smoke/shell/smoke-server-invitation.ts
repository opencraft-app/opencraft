import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createServer} from 'vite';
import {chromium} from 'playwright';

const output=resolve(process.env.OPENCRAFT_SMOKE_OUTPUT??'.local/server-invitation-smoke');
await mkdir(output,{recursive:true});
const source=`
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {ServerSpacesContent} from '/apps/workbench-web/src/components/server-spaces-sidebar.tsx';
import {initializeAppearanceTheme,setThemePreference,setAppearanceThemeId,lavenderThemeId} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const params=new URLSearchParams(location.search);setThemePreference(params.get('theme')==='dark'?'dark':'light');
if(params.get('theme')==='lavender')setAppearanceThemeId(lavenderThemeId);
window.proof={copied:null,joins:[]};
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.proof.copied=value}}});
const controller={hostId:'local',ownerKey:'fixture',selected:'team',directory:{spaces:[{id:'team',name:'Team',memberCount:1,role:'owner'}]},
 command:async command=>{if(command.action==='invite')return {code:'synthetic-invitation',expiresAt:Date.now()+86400000};if(command.action==='join'){window.proof.joins.push(command.code);return {spaceId:'team'}};throw new Error('Unexpected command')},
 select:async()=>true,members:async()=>[],refresh:async()=>{},error:null};
createIntlTestRoot(document.getElementById('root'),undefined,'zh-CN').render(<div className='shell-sidebar__column' style={{width:'min(100vw,360px)',height:'100dvh',display:'block'}}><ServerSpacesContent controller={controller} open onSelected={()=>{}} onClose={()=>{}}/></div>);`;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',cacheDir:'node_modules/.vite-server-invitation',
  optimizeDeps:{include:['react','react-dom/client','@radix-ui/react-focus-scope']},
  resolve:{dedupe:['react','react-dom']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},
  plugins:[{name:'invitation-fixture',resolveId:id=>id==='/invitation-fixture.tsx'?id:null,load:id=>id==='/invitation-fixture.tsx'?source:null,
    configureServer(server){server.middlewares.use((req,res,next)=>{
      const url=new URL(req.url!,'http://fixture.test');
      if(!['/','/chat/private','/servers/team/chat/private','/__opencraft_servers/team/chat/private','/servers/team/','/__opencraft_servers/team/'].includes(url.pathname))return next();
      const prefix=url.pathname.startsWith('/__opencraft_servers/')?'/__opencraft_servers':url.pathname.startsWith('/servers/')?'/servers':null;
      const context=prefix?`<script id="opencraft-server-context" type="application/json">${JSON.stringify({id:'team',name:'Team',basePath:prefix+'/team',selectorPath:prefix,targetOrigin:'http://127.0.0.1:9999'})}</script>`:'';
      res.setHeader('content-type','text/html');res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${context}<div id="root"></div><script type="module" src="/invitation-fixture.tsx"></script></body></html>`);
    });}}]});
await vite.listen();
const origin=`http://127.0.0.1:${(vite.httpServer!.address() as {port:number}).port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
const receipts:unknown[]=[];
try {
  for(const touch of [false,true])for(const theme of ['light','dark','lavender'])for(const deployment of ['local','public','scoped']) {
    const context=await browser.newContext({viewport:{width:touch?390:1100,height:900},hasTouch:touch,isMobile:touch});
    const page=await context.newPage(),errors:string[]=[];page.setDefaultTimeout(15000);
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript('window.__name = target => target;');
    await context.route('https://entry.example/**',async route=>{
      const url=new URL(route.request().url());const response=await route.fetch({url:origin+url.pathname+url.search});await route.fulfill({response});
    });
    const entry=deployment==='local'?origin:'https://entry.example';
    const path=deployment==='scoped'?'/servers/team/chat/private':'/chat/private';
    await page.goto(entry+path+'?theme='+theme+'&private=discard#discard');
    const activate=async(locator:ReturnType<typeof page.getByRole>)=>touch?locator.tap():locator.click();
    await activate(page.getByRole('button',{name:'邀请成员',exact:true}));
    const field=page.getByRole('textbox',{name:deployment==='local'?'邀请码':'邀请链接',exact:true});
    await field.waitFor();
    const expected=deployment==='local'?'synthetic-invitation':entry+(deployment==='scoped'?'/servers/team/':'/')+'?serverInvite=synthetic-invitation';
    assert.equal(await field.inputValue(),expected);
    await activate(page.getByRole('button',{name:deployment==='local'?'复制邀请码':'复制邀请',exact:true}));
    await page.getByRole('button',{name:'已复制',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>(window as any).proof.copied),expected);
    assert.ok(!expected.includes('127.0.0.1'));
    const geometry=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));
    assert.ok(geometry.scrollWidth<=geometry.width+1);
    await page.screenshot({path:join(output,`${touch?'touch':'desktop'}-${theme}-${deployment}.png`),fullPage:true});
    // The real receiving component opens Join Server and submits just the code.
    if(deployment!=='local') {
      await page.goto(expected);
      await page.getByRole('textbox',{name:'邀请链接',exact:true}).waitFor();
      assert.equal(await page.getByRole('textbox',{name:'邀请链接',exact:true}).inputValue(),'synthetic-invitation');
      await activate(page.getByRole('button',{name:'加入 Server',exact:true}).last());
      assert.deepEqual(await page.evaluate(()=>(window as any).proof.joins),['synthetic-invitation']);
    }
    assert.deepEqual(errors,[]);receipts.push({touch,theme,deployment,copyVerified:true,geometry});await context.close();
  }
  await writeFile(join(output,'receipt.json'),JSON.stringify({cases:receipts,boundary:'Real invitation and receiving components with application styles and Intl; synthetic membership RPC and clipboard. No real invitation issued.'},null,2));
  console.log(JSON.stringify({passed:true,cases:receipts.length,output}));
} finally {await browser.close();await vite.close();}
