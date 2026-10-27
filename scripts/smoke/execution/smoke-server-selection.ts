import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from '@playwright/test';
import { selectorFixture, waitFor } from "../../../tests/fixtures/server-selector";
import { AppHostServer } from "../../../packages/app-host-server/src";

const output=resolve(process.env.OPENCRAFT_SELECTOR_SMOKE_DIRECTORY??'.local/server-selector');await mkdir(output,{recursive:true});
const errors:string[]=[],requests:string[]=[],sockets:string[]=[],sshGrants:string[]=[];
const fixture=await selectorFixture({sshPublicAccess:true,legacyDefaultUsers:['alice'],entryName:'OpenCraft',webRoot:resolve(process.env.OPENCRAFT_SELECTOR_WEB_ROOT??'apps/workbench-web/dist'),appHost:()=>new AppHostServer({logicalClientRouting:true,createTransport(){
  const messages=new Set<(frame:string)=>void>(),statuses=new Set<(status:any)=>void>();
  return {status:{state:'idle'} as any,async connect(){this.status={state:'open'};for(const listener of statuses)listener(this.status);},async send(frame:string){
    const rpc=JSON.parse(frame);if(rpc.id===undefined)return;
    const result=rpc.method==='initialize'?{serverInfo:{name:'Isolated selector fixture'}}:rpc.method==='opencraft/codex/accounts/list'?{accounts:[]}:rpc.method==='thread/list'?{data:[],nextCursor:null}:rpc.method==='model/list'?{data:[],nextCursor:null}:rpc.method==='config/read'?{config:{},origins:{}}:{};
    for(const listener of messages)listener(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result,__opencraftClient:rpc.__opencraftClient}));
  },subscribeMessage(listener:any){messages.add(listener);return()=>messages.delete(listener);},subscribeStatus(listener:any){statuses.add(listener);return()=>statuses.delete(listener);},async close(){this.status={state:'closed'};}};
}})});
const browser=await chromium.launch({executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox','--no-proxy-server','--host-resolver-rules=MAP *.selection.test 127.0.0.1']});
try{
  const context=await browser.newContext({extraHTTPHeaders:{'x-fixture-user':'alice'},locale:'zh-CN'}),page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{const path=new URL(r.url()).pathname;requests.push(path);if(r.method()==='POST'&&path.endsWith('/__opencraft_ssh/session'))sshGrants.push(path);});page.on('websocket',s=>sockets.push(new URL(s.url()).pathname));
  // Existing direct settings bookmarks must gain context without changing server.
  await page.goto(fixture.origin+'/settings/servers?retained=one%2Ftwo');
  await page.waitForURL('**/servers/join/settings/servers?retained=one%2Ftwo');
  await page.getByRole('navigation',{name:'Settings sections',exact:true}).getByRole('button',{name:'服务器',exact:true}).waitFor();
  await page.getByText('当前服务器',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>JSON.parse(document.getElementById('opencraft-server-context')!.textContent!).id),'join');
  await page.screenshot({path:join(output,'legacy-join-settings.png')});
  await page.goto(fixture.origin+'/__opencraft_servers');await page.waitForURL('**/servers');await page.getByRole('heading',{name:'选择服务器',exact:true}).waitFor();
  // Hold the parser immediately before the existing final navigation script.
  // This exposes the first-paint document without changing selection decisions.
  let releaseEntry!:()=>void;const entryHeld=new Promise<void>(resolve=>{releaseEntry=resolve;});
  let entered!:()=>void;const entering=new Promise<void>(resolve=>{entered=resolve;});
  const holdEntry=async(route:any)=>{entered();await entryHeld;await route.fulfill({contentType:'text/javascript',body:''});};
  const entryDocument=async(route:any)=>{const response=await route.fetch({url:fixture.base+'/',headers:{...route.request().headers(),host:fixture.host}});const html=await response.text();const last=html.lastIndexOf('<script>');assert.ok(last>=0);await route.fulfill({response,body:html.slice(0,last)+'<script src="/__entry-probe-delay.js"></script>'+html.slice(last)});};
  await page.route('**/__entry-probe-delay.js',holdEntry);await page.route(fixture.origin+'/',entryDocument);
  await page.goto(fixture.origin,{waitUntil:'commit'});await Promise.race([entering,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Entry parser hold did not start')),15000))]);
  for(const width of [390,1280])for(const colorScheme of ['light','dark'] as const){
    await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme});
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole('heading',{name:'选择服务器',exact:true}).isVisible(),false,'automatic entry never paints the chooser');
    assert.equal(await page.locator('[data-server="join"]').isVisible(),false,'automatic entry never exposes selectable targets');
    assert.equal(await page.getByRole('status').count(),0,'automatic entry has no intermediate status');
    assert.equal((await page.locator('body').innerText()).trim(),'','automatic entry stays silent until navigation');
    await page.screenshot({path:join(output,`automatic-entry-${width}-${colorScheme}.png`)});
  }
  releaseEntry();await page.unroute('**/__entry-probe-delay.js',holdEntry);await page.unroute(fixture.origin+'/',entryDocument);
  await page.waitForURL('**/servers/join/**');await page.locator('[data-action-id]').first().waitFor({timeout:60_000});
  await page.goto(fixture.origin+'/servers');await page.getByRole('heading',{name:'选择服务器',exact:true}).waitFor();
  assert.equal(await page.locator('[data-server="join"]').innerText(),'OpenCraft');
  for(const width of [320,390,1280])for(const colorScheme of ['light','dark'] as const){await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme});await page.screenshot({path:join(output,`chooser-${width}-${colorScheme}.png`)});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  await page.locator('[data-server="lighthouse"]').click();await page.waitForURL('**/servers/lighthouse/**');
  await page.locator('[data-action-id]').first().waitFor({timeout:60_000});
  await page.screenshot({path:join(output,'lighthouse-workbench.png')});
  await page.goto(fixture.origin+'/__opencraft_servers/lighthouse/');await page.waitForURL('**/servers/lighthouse/');await page.locator('[data-action-id]').first().waitFor();
  // Direct URL wins over Lighthouse memory and becomes the next root destination.
  // A second tab's successful entry must never retarget this existing page.
  const direct=await context.newPage();
  await direct.goto(fixture.origin+'/servers/join/settings/servers?direct=one%2Ftwo#retained',{waitUntil:'commit'});
  assert.equal(new URL(direct.url()).pathname,'/servers/join/settings/servers');
  assert.equal(new URL(direct.url()).search,'?direct=one%2Ftwo');assert.equal(new URL(direct.url()).hash,'#retained');
  await direct.getByText('当前服务器',{exact:true}).waitFor();
  await direct.goto(fixture.origin);await direct.waitForURL('**/servers/join/**');
  await direct.goto(fixture.origin+'/servers/lighthouse/settings/servers?direct=2');
  await direct.getByText('当前服务器',{exact:true}).waitFor();
  // An embedded successful document and a background HTML read are not entry.
  await direct.evaluate(async()=>{
    const iframe=document.createElement('iframe');iframe.src='/servers/join/fixture/compressed.html';
    const loaded=new Promise<void>(resolve=>iframe.onload=()=>resolve());document.body.append(iframe);await loaded;iframe.remove();
    await fetch('/servers/join/fixture/compressed.html',{headers:{accept:'text/html'}}).then(r=>r.text());
  });
  await direct.goto(fixture.origin);await direct.waitForURL('**/servers/lighthouse/**');
  await direct.reload();await direct.locator('[data-action-id]').first().waitFor();
  assert.match(new URL(direct.url()).pathname,/^\/servers\/lighthouse\/?$/u);await direct.close();
  const noStorage=await browser.newContext({extraHTTPHeaders:{'x-fixture-user':'alice'}});
  await noStorage.addInitScript(()=>{Storage.prototype.setItem=Storage.prototype.getItem=()=>{throw new Error('Storage unavailable');};});
  const noStoragePage=await noStorage.newPage();
  await noStoragePage.goto(fixture.origin+'/servers/lighthouse/fixture/compressed.html');
  assert.equal(await noStoragePage.title(),'Compressed');
  assert.equal(new URL(noStoragePage.url()).pathname,'/servers/lighthouse/fixture/compressed.html');await noStorage.close();
  const cookieIsolation=await page.evaluate(async()=>{await fetch('/servers/lighthouse/fixture/stream').then(r=>r.text());return fetch('/servers/lighthouse/fixture/headers').then(r=>r.json());});assert.match(cookieIsolation.cookie,/(?:^|; )private-target=not-shared(?:;|$)/u);assert.doesNotMatch(cookieIsolation.cookie,/opencraft-relay-session/u);
  const session=await page.evaluate(()=>fetch('/servers/lighthouse/__opencraft_access/session').then(r=>r.json()));assert.equal(session.role,'member');
  const dataScope=await page.evaluate(()=>indexedDB.databases().then(xs=>xs.map(x=>x.name)));assert.ok(dataScope.some(x=>x?.includes('server:lighthouse:')));
  await page.reload();await page.locator('[data-action-id]').first().waitFor();assert.match(page.url(),/\/lighthouse(?:\/|\?|$)/u);
  // Choosing the managed site in a second tab changes only future entry preference, never tab A's URL or requests.
  const bookmark=await context.newPage();await bookmark.goto(fixture.origin+'/settings/servers?existing=1');
  await bookmark.waitForURL('**/servers/join/settings/servers?existing=1');await bookmark.getByText('当前服务器',{exact:true}).waitFor();
  assert.equal(await bookmark.evaluate(()=>JSON.parse(document.getElementById('opencraft-server-context')!.textContent!).id),'join');await bookmark.close();
  const other=await context.newPage();await other.goto(fixture.origin+'/servers');await other.locator('[data-server="join"]').click();await other.locator('[data-action-id]').first().waitFor();
  // Exercise actual Workbench discovery against real SSH management and relay.
  await page.waitForTimeout(6500);
  const discovery=await page.evaluate(async()=>{
    const context=JSON.parse(document.getElementById('opencraft-server-context')!.textContent!);
    const session=await fetch(context.basePath+'/__opencraft_ssh/session').then(r=>r.json());
    return {session,targetOrigin:context.targetOrigin,errors:document.querySelectorAll('.sidebar-catalog-feedback').length};
  });
  assert.equal(discovery.session.authenticated,true);
  assert.equal(discovery.session.authenticatedOrigin,discovery.targetOrigin);
  assert.equal(discovery.errors,0);
  assert.equal(sshGrants.filter(path=>path.includes('/lighthouse/')).length,1,'discovery and page reload reuse the same SSH grant');
  assert.match(page.url(),/\/lighthouse(?:\/|\?|$)/u);assert.match(other.url(),/\/join(?:\/|\?|$)/u);
  const joinRole=await other.evaluate(()=>fetch('/servers/join/__opencraft_access/session').then(r=>r.json()));assert.equal(joinRole.role,'admin');const otherCookies=await other.evaluate(()=>fetch('/servers/join/fixture/headers').then(r=>r.json()));assert.ok(otherCookies.cookie===null || /^opencraft_ssh_session_http=/u.test(otherCookies.cookie));assert.doesNotMatch(otherCookies.cookie??'',/private-target/u);
  await page.goto(fixture.origin);await page.waitForURL(url=>url.pathname.startsWith('/servers/join'));await page.locator('[data-action-id]').first().waitFor();
  // Settings owns server switching; the chooser still opens with a saved choice.
  assert.equal(await page.locator('.shell-navigation__items').getByRole('button',{name:/切换服务器|Switch server/u}).count(),0);
  await page.getByRole('button',{name:'设置',exact:true}).first().click();
  await page.getByRole('navigation',{name:'Settings sections',exact:true}).getByRole('button',{name:'服务器',exact:true}).click();
  await page.getByText('当前服务器',{exact:true}).waitFor();
  await page.getByRole('button',{name:/切换服务器|Switch server/u}).click();await page.getByRole('heading',{name:'选择服务器',exact:true}).waitFor();
  await page.locator('[data-server="lighthouse"]').click();await page.locator('[data-action-id]').first().waitFor();
  fixture.stores[1]!.set(fixture.principals.alice!,'member',false,'fixture-administrator');await page.goto(fixture.origin);await page.getByRole('heading',{name:'选择服务器',exact:true}).waitFor();
  assert.equal(await page.locator('[data-server="lighthouse"]').count(),0);assert.match(await page.locator('p').first().innerText(),/不可用/u);
  await page.goto(fixture.origin);await page.getByRole('heading',{name:'选择服务器',exact:true}).waitFor();
  assert.match(await page.locator('p').first().innerText(),/不可用/u);
  // Different verified identity in the same browser does not inherit Alice's saved choice.
  const logout=await page.evaluate(()=>fetch('/__opencraft_relay/logout',{method:'POST'}).then(r=>r.status));assert.equal(logout,204);
  await context.setExtraHTTPHeaders({'x-fixture-user':'bob'});await page.goto(fixture.origin);await page.getByRole('heading',{name:'选择服务器',exact:true}).waitFor();
  assert.equal(await page.locator('[data-server="join"]').count(),1);assert.equal(await page.locator('[data-server="lighthouse"]').count(),0);
  const noScript=await browser.newContext({javaScriptEnabled:false,extraHTTPHeaders:{'x-fixture-user':'alice'}});
  const noScriptPage=await noScript.newPage();await noScriptPage.goto(fixture.origin);
  await noScriptPage.getByRole('heading',{name:'选择服务器',exact:true}).waitFor();
  assert.ok(await noScriptPage.locator('[data-server="join"]').isVisible());await noScript.close();
  const escaped=requests.filter(path=>/^(?:\/assets\/|\/apphost|\/appserver|\/__opencraft_access|\/__opencraft_enterprise_identity|\/__opencraft_ssh|\/__opencraft_updates|\/opencraft-icon\.svg)/u.test(path));assert.deepEqual(escaped,[],'business requests and assets stay under the selected target');
  assert.ok(sockets.some(x=>x.startsWith('/servers/lighthouse/apphost')));assert.ok(sockets.some(x=>x.startsWith('/servers/join/apphost')));
  await page.locator('[data-server="join"]').click();await page.locator('[data-action-id]').first().waitFor();
  fixture.clients[0]!.close();await waitFor(()=>!fixture.relay.connected('join'));
  await page.goto(fixture.origin);await page.getByRole('heading',{name:'选择服务器',exact:true}).waitFor();
  assert.equal(await page.locator('[data-server]').count(),0);assert.match(await page.locator('p').first().innerText(),/不可用/u);
  // A new browser for an existing identity still gets its migration default.
  // With that target offline it stays at the chooser, despite another admitted server.
  fixture.stores[1]!.set(fixture.principals.alice!,'member',true,'fixture-administrator');
  const fresh=await browser.newContext({extraHTTPHeaders:{'x-fixture-user':'alice'}}),freshPage=await fresh.newPage();
  await freshPage.goto(fixture.origin);await freshPage.getByRole('heading',{name:'选择服务器',exact:true}).waitFor();
  assert.equal(await freshPage.locator('[data-server="lighthouse"]').count(),1);
  assert.match(await freshPage.locator('p').first().innerText(),/不可用/u);await fresh.close();
  assert.deepEqual(errors,[]);
  await writeFile(join(output,'receipt.json'),JSON.stringify({actualBuiltWorkbench:true,automaticEntryDoesNotPaintChooser:true,noScriptLinksAvailable:true,explicitUrlWins:true,directEntryBecomesRememberedChoice:true,deepLinkPreservesQueryAndFragment:true,backgroundAndIframeDoNotChangeChoice:true,storageUnavailableDirectEntry:true,legacySettingsBookmark:true,realSshDiscovery:discovery,sshGrantRequests:sshGrants,existingUserDefault:true,defaultNeverOverridesChoice:true,newIdentityShowsChooser:true,unavailableDefaultNeverFallsBack:true,realRelayCoreMembership:true,rememberedChoice:true,multiTabIsolation:true,independentTargetRoles:true,revocationReturnsChooser:true,identitySwitchDoesNotReuseChoice:true,offlineReturnsChooser:true,dataScope,sockets,escaped,errors,boundary:'Synthetic verified identity and Codex transport only; actual packaged Workbench, Chromium, relay tunnel and target membership. No production employee identity or model inference.'},null,2));
  console.log(JSON.stringify({output,success:true}));
} catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),errors,requests,sockets},null,2));throw error;}
finally{await browser.close();await fixture.close();}
