import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
// Real console wrapper and release component; only remote APIs use synthetic data.
const root = fileURLToPath(new URL('../..', import.meta.url));
const serveOnly = process.argv.includes('--serve-only');
const fixture = `
import React, {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AgentChatMigrationSurface} from './src/pages/marketing/opencraft-embedded-workbench';
import {installConsoleShowCommand,subscribeConsoleShow} from './src/lib/console-show-event';
import {writeStoredAuthToken} from './src/repositories/http-repositories';
writeStoredAuthToken('synthetic-browser-session');
function Host(){const [enabled,setEnabled]=useState(false);const [owner,setOwner]=useState('legacy');
 useEffect(()=>{const release=installConsoleShowCommand();const stop=subscribeConsoleShow(setEnabled);return ()=>{stop();release();};},[]);
 return <main><h1>国内控制台 Chat 隐藏开关验证</h1><p>本地合成账号与 API；不连接真实云实例</p><button onClick={()=>window.show()}>切换隐藏预览</button><output data-owner={owner}>{owner}</output><AgentChatMigrationSurface active enabled={enabled} accountId='account-1' apiBase={location.origin+'/api'} instanceId='ins-test' profileId='main' region='cn' legacy={<div data-legacy>AgentChat（保留原入口）</div>} multiSession={{onSessionStateChange(){},onSelectedChatIdChange(){}}} onOwnerChange={setOwner}/></main>;
}
createRoot(document.getElementById('root')).render(<Host/>);
`;
const built = await build({stdin:{contents:fixture,resolveDir:join(root,'frontend'),sourcefile:'cn-embed-browser.tsx',loader:'tsx'},bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic',tsconfig:join(root,'frontend/tsconfig.json'),define:{'process':'{"env":{}}','process.env.NODE_ENV':'"production"','process.env.NEXT_PUBLIC_OPENCRAFT_EMBED_SCRIPT_URL':'"/__opencraft/embedded-workbench.js"','import.meta.env':'{}'},loader:{'.css':'empty','.scss':'empty'}});
let requests = [];
let modules = 0;
const apiReplies = (path) => {
 if(path.startsWith('/api/v1/instances')) return {data:{items:[],total:0}};
 if(path==='/api/auth/profile') return {user:{id:'account-1',name:'Synthetic user'}};
 if(path.includes('passes')) return {data:{passes:[]}};
 if(path.includes('subscription')) return {data:{hasSubscription:false}};
 return {data:{}};
};
const server=createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/api/')) { requests.push({path:url.pathname,authenticated:req.headers.authorization==='Bearer synthetic-browser-session'});res.setHeader('content-type','application/json');res.end(JSON.stringify(apiReplies(url.pathname)));return;}
 if(url.pathname==='/fixture.js'){res.setHeader('content-type','text/javascript');res.end(built.outputFiles[0].contents);return;}
 if(url.pathname.startsWith('/__opencraft/')){modules++; const rel=url.pathname.slice('/__opencraft/'.length);if(rel.includes('..'))throw Error('invalid path');const body=await readFile(join(root,'opencraft/apps/workbench-web/dist-embedded-workbench',rel));res.setHeader('content-type',({'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'})[extname(rel)]||'application/octet-stream');res.end(body);return;}
 res.setHeader('content-type','text/html');res.end('<!doctype html><html lang="zh-CN"><head><style>body{font:16px system-ui;padding:24px}main{height:600px}.relative{position:relative;height:500px}.z-10{z-index:10}.inset-x-0{left:0;right:0}.top-0{top:0}.absolute{position:absolute}.inset-0{inset:0}.invisible{visibility:hidden}[inert]{pointer-events:none}opencraft-embedded-workbench{height:500px}p{color:#666}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
}catch(error){res.statusCode=404;res.end('Not found');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
if (serveOnly) {
 console.log('Recovery fixture: http://127.0.0.1:'+server.address().port);
 await new Promise(()=>{});
}
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const page=await browser.newPage({viewport:{width:1200,height:800}});page.setDefaultTimeout(20000);
 const errors=[];const warnings=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE',e.message);});page.on('console',m=>{if(m.type()==='warning')warnings.push(m.text());});
 await page.goto('http://127.0.0.1:'+server.address().port+'/#session_token=synthetic-unrelated-fragment');
 await page.locator('[data-legacy]').waitFor();assert.equal(modules,0);assert.equal(requests.length,0);
 assert.equal(await page.evaluate(()=>window.show()),true);
 await page.waitForFunction(()=>Boolean(customElements.get('opencraft-embedded-workbench')));
 await page.waitForFunction(()=>document.querySelector('opencraft-embedded-workbench'));
 const until=Date.now()+20000;while(requests.length<2 && Date.now()<until)await new Promise(r=>setTimeout(r,100));
 assert.ok(requests.some(r=>r.path==='/api/auth/profile'));assert.ok(requests.some(r=>r.path==='/api/v1/instances'));assert.ok(requests.every(r=>r.authenticated));
 await page.getByRole('button',{name:'重新连接',exact:true}).waitFor();
 await page.getByText('请检查 AI 伙伴状态后重试',{exact:true}).waitFor();
 assert.equal(await page.locator('[data-legacy]').count(),0);
 await page.getByRole('button',{name:'重新连接',exact:true}).click();
 await page.getByRole('button',{name:'重新连接',exact:true}).waitFor();
 await page.getByText('请检查 AI 伙伴状态后重试',{exact:true}).waitFor();
 assert.equal(await page.locator('[data-legacy]').count(),0);
 assert.equal(await page.evaluate(()=>document.querySelector('opencraft-embedded-workbench').submitPrompt('blocked-template','synthetic workbench template')),false);
 assert.equal(await page.evaluate(()=>localStorage.getItem('vela.lightvela.session-token.v1')),null);
 assert.equal(await page.evaluate(()=>location.hash),'#session_token=synthetic-unrelated-fragment');
 assert.equal(await page.evaluate(()=>window.show()),false);
 await page.waitForFunction(()=>!document.querySelector('opencraft-embedded-workbench'));
 assert.deepEqual(errors,[]);
 const evidence=join(tmpdir(),'cn-opencraft-browser-evidence');await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,'hidden-chat-recovery.png')});
 console.log(JSON.stringify({result:'PASS',realBuiltComponent:true,defaultModuleRequests:0,authenticatedRequests:requests.length,hostOAuthPreserved:true,openCraftPersistentToken:false,disabledComponentDisposed:true,noSilentLegacyFallback:true,pageErrors:errors,evidence}));
}finally{await browser?.close();await new Promise(r=>server.close(r));}
