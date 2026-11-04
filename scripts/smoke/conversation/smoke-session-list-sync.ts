import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {ThreadCatalog} from '../../../apps/local-agent-host/src/thread-catalog.js';
const output=process.env.OPENCRAFT_SMOKE_OUTPUT ?? '/tmp/opencraft-session-list-sync';
const store=new ThreadCatalog(),events:any[]=[];
const rows=Array.from({length:130},(_,i)=>({id:`t${i}`,cwd:'/synthetic',createdAt:1,updatedAt:1000-i,name:`Thread ${i}`,preview:'',status:{type:'idle'},ephemeral:false,turns:[]}));
const directory=store.createProjection({list:async params=>({data:params.archived ? [] : rows,nextCursor:null}),changed:event=>{if(event)events.push(event);}});
await directory.refresh();
let hold=true,expireOnce=false,release:(()=>void)|undefined,requests=0;
const vite=await createServer({configFile:false,root:process.cwd(),resolve:{dedupe:['react','react-dom']},cacheDir:'node_modules/.vite-session-list-sync',optimizeDeps:{entries:['tests/fixtures/catalog-entry-browser.tsx']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0},plugins:[{name:'versioned-catalog',configureServer(server){server.middlewares.use(async(req,res,next)=>{
 try{
  if(req.url?.split('?')[0]==='/') {res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/catalog-entry-browser.tsx"></script>');return;}
  if(req.url?.split('?')[0]!=='/catalog-page')return next();
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const params=JSON.parse(Buffer.concat(chunks).toString());requests++;
  if(params.cursor!=='opencraft-catalog-snapshot-v1:start'&&hold)await new Promise<void>(resolve=>{release=resolve;});
  if(params.cursor!=='opencraft-catalog-snapshot-v1:start'&&expireOnce){expireOnce=false;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:{code:-32086,message:'Snapshot expired'}}));return;}
  const scenario=new URL(req.url!,'http://localhost').searchParams.get('scenario');
  const page=scenario==='cold-error'?{data:[],nextCursor:null,catalog:{state:'error',coverage:'unknown'}}:await directory.list({...params,sortKey:'updated_at'});
  if(params.cursor==='opencraft-catalog-snapshot-v1:start')Object.assign(page,{catalogDecorations:{pins:[{...rows[120],name:'stale pin name'}]}});
  res.setHeader('content-type','application/json');res.end(JSON.stringify(page));
 }catch(error){console.error('fixture-request',String(error));res.statusCode=500;res.end('{}');}
});}}]});
let browser:any;
try{
 await mkdir(output,{recursive:true});await vite.listen();
 browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 const origin=`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
 const page=await browser.newPage({viewport:{width:1100,height:800}}),errors:string[]=[];page.on('pageerror',(e:Error)=>{errors.push(e.message);console.error('pageerror',e.message);});page.on('console',(m:any)=>{if(m.type()==='error')console.error('browser',m.text());});
 await page.addInitScript('window.__name=value=>value');await page.goto(origin+'/?versioned=1');
 await page.waitForFunction(()=>((window as any).catalogEntry?.displayed().length??0)>=50).catch(async error=>{console.error(JSON.stringify({requests,errors,state:await page.evaluate(()=>(window as any).catalogEntry?.snapshot()),text:await page.locator('body').innerText()}));throw error;});
 directory.observe('thread/started',{thread:{...rows[129],updatedAt:3000,name:'live-new'}});
 const live=events.at(-1);await page.evaluate((event:any)=>(window as any).catalogEntry.event({method:'opencraft/thread-catalog/changed',params:event}),live);
 hold=false;release?.();await page.waitForFunction(()=>{const s=(window as any).catalogEntry?.snapshot();return s&&s.status==='success'&&!s.fetching&&!s.partial;});
 let data=await page.evaluate(()=>(window as any).catalogEntry.displayed());assert.equal(data.length,130);assert.equal(data[0].name,'live-new');
 assert.equal(data.find((r:any)=>r.id==='t120').name,'Thread 120');assert.equal(data.find((r:any)=>r.id==='t120').pinned,true);
 // The two subsequent mutations are deliberately not delivered to the browser.
 directory.observe('thread/name/updated',{threadId:'t129',name:'recovered-name'});directory.observe('thread/deleted',{threadId:'t129'});
 await page.evaluate(()=>(window as any).catalogEntry.refresh());
 await page.waitForFunction(()=>!(window as any).catalogEntry.snapshot().fetching);
 data=await page.evaluate(()=>(window as any).catalogEntry.displayed());assert.equal(data.some((r:any)=>r.id==='t129'),false);assert.equal(data.length,129);
 expireOnce=true;await page.evaluate(()=>(window as any).catalogEntry.refresh());
 await page.waitForFunction(()=>{const state=(window as any).catalogEntry.snapshot();return state.status==='success'&&!state.fetching&&!state.partial&&(window as any).catalogEntry.displayed().length===129;});
 assert.equal(expireOnce,false,'an expired continuation was exercised and recovered automatically');
 await page.screenshot({path:output+'/recovered-desktop.png'});
 const touch=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const cold=await touch.newPage();cold.on('pageerror',(e:Error)=>errors.push(e.message));
 await cold.addInitScript('window.__name=value=>value');await cold.goto(origin+'/?versioned=1&scenario=cold-error&theme=dark');
 await cold.waitForFunction(()=>{const s=(window as any).catalogEntry?.snapshot();return s&&s.status==='error'&&!s.fetching;});
 const before=requests;await cold.waitForTimeout(300);assert.equal(requests,before,'failed coverage must not poll in a tight loop');
 await cold.screenshot({path:output+'/cold-error-touch-dark.png'});assert.deepEqual(errors,[]);
 await writeFile(output+'/results.json',JSON.stringify({scope:'actual Sidebar/hooks with synthetic Host and real ThreadDirectory',initialRows:130,recoveredRows:data.length,requests,errors,coldError:'error, not fetching; stable request count'},null,2));
 console.log(JSON.stringify({output,initialRows:130,recoveredRows:data.length,requests,errors}));await touch.close();
}finally{release?.();if(browser)await browser.close();await vite.close();store.close();}
