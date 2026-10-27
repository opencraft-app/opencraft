import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from '@playwright/test';
import { selectorFixture, waitFor } from "../../../tests/fixtures/server-selector";
import { AppHostServer } from "../../../packages/app-host-server/src";

const output=resolve(process.env.OPENCRAFT_SELECTOR_SMOKE_DIRECTORY??'.local/server-selector');await mkdir(output,{recursive:true});
const errors:string[]=[],requests:string[]=[],sockets:string[]=[],sshGrants:string[]=[];
const fixture=await selectorFixture({sshPublicAccess:true,serverPaths:{aliases:{join:'main',lighthouse:'research'},defaultServer:'join'},entryName:'Main',webRoot:resolve(process.env.OPENCRAFT_SELECTOR_WEB_ROOT??'apps/workbench-web/dist'),appHost:()=>new AppHostServer({logicalClientRouting:true,createTransport(){
  const messages=new Set<(frame:string)=>void>(),statuses=new Set<(status:any)=>void>();
  return {status:{state:'idle'} as any,async connect(){this.status={state:'open'};for(const listener of statuses)listener(this.status);},async send(frame:string){
    const rpc=JSON.parse(frame);if(rpc.id===undefined)return;
    const result=rpc.method==='initialize'?{serverInfo:{name:'Isolated selector fixture'}}:rpc.method==='opencraft/codex/accounts/list'?{accounts:[]}:rpc.method==='thread/list'?{data:[],nextCursor:null}:rpc.method==='model/list'?{data:[],nextCursor:null}:rpc.method==='config/read'?{config:{},origins:{}}:{};
    for(const listener of messages)listener(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result,__opencraftClient:rpc.__opencraftClient}));
  },subscribeMessage(listener:any){messages.add(listener);return()=>messages.delete(listener);},subscribeStatus(listener:any){statuses.add(listener);return()=>statuses.delete(listener);},async close(){this.status={state:'closed'};}};
}})});
const browser=await chromium.launch({executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox','--no-proxy-server','--host-resolver-rules=MAP *.selection.test 127.0.0.1']});
try {
  const context=await browser.newContext({extraHTTPHeaders:{'x-fixture-user':'alice'},locale:'zh-CN'});
  context.setDefaultTimeout(20000);const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{const path=new URL(r.url()).pathname;requests.push(path);if(r.method()==='POST'&&path.endsWith('/__opencraft_ssh/session'))sshGrants.push(path);});
  page.on('websocket',s=>sockets.push(new URL(s.url()).pathname));
  const loaded=async(p:any,id:string)=>{
    await p.waitForFunction((id:string)=>JSON.parse(document.getElementById('opencraft-server-context')?.textContent??'null')?.id===id,id);
    await p.locator('[data-action-id]').first().waitFor();
  };
  await page.goto(fixture.origin);await loaded(page,'join');assert.equal(new URL(page.url()).pathname,'/');
  await page.goto(fixture.origin+'/servers/main/fixture/compressed.html?retained=one%2Ftwo#fragment');
  assert.equal(await page.title(),'Compressed');
  assert.equal(new URL(page.url()).pathname,'/fixture/compressed.html');
  assert.equal(new URL(page.url()).search,'?retained=one%2Ftwo');assert.equal(new URL(page.url()).hash,'#fragment');
  await page.goto(fixture.origin+'/settings/servers');await page.getByText('当前服务器',{exact:true}).waitFor();
  assert.equal(new URL(page.url()).pathname,'/settings/servers');await page.screenshot({path:join(output,'default-settings.png')});
  await page.getByRole('button',{name:'切换服务器',exact:true}).click();
  await page.getByRole('heading',{name:'选择服务器',exact:true}).waitFor();
  assert.equal(await page.locator('[data-server="lighthouse"]').getAttribute('href'),'/servers/research/');
  await page.locator('[data-server="lighthouse"]').click();await loaded(page,'lighthouse');
  assert.match(new URL(page.url()).pathname,/^\/servers\/research\/?$/u);
  await page.reload();await loaded(page,'lighthouse');
  await page.goto(fixture.origin);await loaded(page,'lighthouse');
  assert.match(new URL(page.url()).pathname,/^\/servers\/research\/?$/u);
  await page.goto(fixture.origin+'/servers/research/settings/servers');await page.getByText('当前服务器',{exact:true}).waitFor();
  await page.screenshot({path:join(output,'named-settings.png')});
  const other=await context.newPage();await other.goto(fixture.origin+'/servers/main/settings/servers');
  await other.getByText('当前服务器',{exact:true}).waitFor();assert.equal(new URL(other.url()).pathname,'/settings/servers');
  assert.equal(new URL(page.url()).pathname,'/servers/research/settings/servers');
  await other.goto(fixture.origin);await loaded(other,'join');assert.equal(new URL(other.url()).pathname,'/');
  const idb=await page.evaluate(()=>indexedDB.databases().then(xs=>xs.map(x=>x.name)));
  assert.ok(idb.some(x=>x?.includes('server:lighthouse:')));assert.ok(idb.some(x=>x?.includes('server:join:')));
  assert.ok(!idb.some(x=>x?.includes('server:research:')));
  await page.evaluate(async()=>{
    await fetch('/fixture/stream').then(r=>r.text());await fetch('/servers/research/fixture/stream').then(r=>r.text());
  });
  const cookies=await context.cookies();
  const scopes=cookies.filter(c=>c.name.includes('opencraft-server-'));
  assert.ok(scopes.some(c=>c.path==='/'));assert.ok(scopes.some(c=>c.path==='/servers/research/'));
  const session=await page.evaluate(()=>fetch('/servers/research/__opencraft_access/session').then(r=>r.json()));assert.equal(session.role,'member');
  const defaultSession=await other.evaluate(()=>fetch('/__opencraft_access/session').then(r=>r.json()));assert.equal(defaultSession.role,'admin');
  // Other accounts never inherit a browser preference or gain target membership.
  const bob=await browser.newContext({extraHTTPHeaders:{'x-fixture-user':'bob'}}),b=await bob.newPage();
  await b.goto(fixture.origin+'/servers');assert.equal(await b.locator('[data-server="lighthouse"]').count(),0);
  const denied=await b.evaluate(()=>fetch('/servers/research/__opencraft_access/session').then(r=>r.status));assert.equal(denied,403);await bob.close();
  await page.goto(fixture.origin+'/servers/research/');await loaded(page,'lighthouse');
  { fixture.stores[1]!.set(fixture.principals.alice!,'member',false,'fixture'); }
  await page.reload();await page.getByRole('heading',{name:'选择服务器',exact:true}).waitFor();
  assert.equal(new URL(page.url()).pathname,'/servers');
  assert.equal(await page.locator('[data-server="lighthouse"]').count(),0);
  await other.reload();await loaded(other,'join');assert.equal(new URL(other.url()).pathname,'/');
  assert.ok(sockets.some(path=>path.startsWith('/servers/research/')));assert.ok(sockets.some(path=>!path.startsWith('/servers/')));
  assert.deepEqual(errors,[]);
  await writeFile(join(output,'receipt.json'),JSON.stringify({success:true,errors,requests,sockets,sshGrants,
    checks:['readable label independent of stable identity','default has no prefix','canonical query/fragment','settings switch','URL beats memory','remember successful direct entry','reload and tabs','per-target roles and revocation','cookie and IDB isolation','real HTTP/WS paths'],
    boundary:'Real built Workbench, relay, SSH management and target ACL. Verified identities and model transport are isolated fixtures.'},null,2));
  console.log(JSON.stringify({success:true,output}));await context.close();
} finally {await browser.close();await fixture.close();}
