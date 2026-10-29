import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HostFileDownloads } from "../../apps/opencraft-daemon/src/host-file-downloads.js";
import { HtmlFilePreviews } from "../../scripts/html-file-previews.mjs";
import { createWorkbenchWebServer } from "../../scripts/serve-workbench-web.mjs";
import { isHeadlessBackendPath } from "../../scripts/web-deployment/headless-backend.mjs";

async function fixture(t: test.TestContext, gateway = false, remote = false) {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-html-preview-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = join(directory,"report.html");
  await writeFile(join(directory,"index.html"),"<!doctype html><title>app</title>");
  await writeFile(report,'<!doctype html><html><body><details><summary>场景</summary><p>真实回归</p></details><button onclick="document.querySelector(\'details\').open=true">全部展开</button><img src="image.png"><link rel="stylesheet" href="style.css"><script>window.loaded=true</script></body></html>');
  await writeFile(join(directory,"image.png"),Buffer.from("89504e470d0a1a0a","hex"));
  await writeFile(join(directory,"style.css"),'body{background-image:url("image.png")}');
  let allowed = true, clock = 1_000;
  const files = new HostFileDownloads(host => {
    if(host !== (remote ? 'ssh:fixture' : 'local-codex')) throw Error('Unknown Host');
    return remote ? {hostname:'fixture',username:'fixture',port:22,knownHostsFile:'/unused',authentication:{kind:'agent' as const}} : 'local';
  }, args => spawn('sh',['-c',args.at(-1)!],{stdio:['pipe','pipe','pipe']}));
  const previews = gateway ? null : new HtmlFilePreviews((...args: Parameters<typeof files.readPreview>) => files.readPreview(...args), {now:()=>clock,ticketMs:100,sessionMs:1000});
  let origin = '';
  const web = gateway ? await createWorkbenchWebServer({root:directory,appServerTarget:null,fileDownloads:files,
    identityService:{admissionStatus:(r: any)=>allowed && r.headers['x-test-actor']==='issuer'?204:401,connectionContext:()=>({sender:null}),handle:()=>false},
    actorService:{isSessionRequest:()=>false,legacyAdmissionStatus:()=>allowed?204:403},
    sshManagement:{authorized:()=>allowed,onRevocation:()=>()=>{}}}) : null;
  const server = web ? null : createServer((req,res)=>{
    if (req.url==='/__opencraft_preview/tickets') void previews!.issue(req,res,()=>allowed);
    else void previews!.handlePublic(req,res,r=>r.headers.origin===origin).then(found=>{if(!found){res.writeHead(404);res.end();}});
  });
  const address = web ? await web.listen({host:'127.0.0.1',port:0}) : await new Promise<any>(resolve=>server!.listen(0,'127.0.0.1',()=>resolve(server!.address())));
  origin=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{previews?.close();files.close();if(web)await web.close();else{server!.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}});
  const post = (path:string,body:unknown,headers:Record<string,string>={})=>fetch(origin+path,{method:'POST',headers:{Origin:origin,'content-type':'application/json',...(gateway?{'x-test-actor':'issuer'}:{}),...headers},body:JSON.stringify(body)});
  const issue = (path=report,hostId=remote?'ssh:fixture':'local-codex')=>post('/__opencraft_preview/tickets',{hostId,path});
  const redeem=(ticket:string)=>post('/__opencraft_preview/redeem',{ticket});
  return {directory,report,files,origin,post,issue,redeem,revoke(){allowed=false;},advance(ms:number){clock+=ms;}};
}
async function capability(f:Awaited<ReturnType<typeof fixture>>) {
  const issued=await f.issue();assert.equal(issued.status,201);const entry=await issued.json();
  assert.match(entry.path,/^\/__opencraft_preview\/#ticket=[\w-]{32}$/u);
  const ticket=new URL('http://unused'+entry.path).hash.slice('#ticket='.length);
  const redemption=await f.redeem(ticket);assert.equal(redemption.status,200);
  const session=await redemption.json();const cookie=redemption.headers.get('set-cookie')!.split(';')[0]!;
  return {ticket,cookie,path:'/__opencraft_preview/'+session.path.slice(2),rawCookie:redemption.headers.get('set-cookie')!};
}

test('ticket redeems once, refresh uses a purpose-limited HttpOnly cookie, and content is frozen',async t=>{
 const f=await fixture(t),c=await capability(f);
 assert.match(c.rawCookie,/HttpOnly/u);assert.match(c.rawCookie,/SameSite=Strict/u);
 assert.equal((await f.redeem(c.ticket)).status,410);
 const shell=await fetch(f.origin+c.path,{headers:{Cookie:c.cookie}});assert.equal(shell.status,200);
 assert.match(await shell.text(),/sandbox="allow-scripts"/u);
 await writeFile(f.report,'changed after issue');
 for(let i=0;i<2;i++){
  const page=await fetch(f.origin+c.path+'document',{headers:{Cookie:c.cookie}});assert.equal(page.status,200);
  assert.match(page.headers.get('content-security-policy')!,/sandbox allow-scripts/u);
  const content=await page.text();assert.match(content,/真实回归/u);assert.match(content,/data:image\/png;base64,/u);assert.match(content,/data:text\/css;base64,/u);
  assert.doesNotMatch(content,/changed after issue/u);assert.equal(page.headers.get('referrer-policy'),'no-referrer');
 }
 assert.equal((await fetch(f.origin+c.path)).status,403);
 assert.equal((await fetch(f.origin+c.path+'image.png',{headers:{Cookie:c.cookie}})).status,404);
});

test('a scanner GET does not redeem; fragment removal precedes POST; concurrent redemption has one winner',async t=>{
 const f=await fixture(t),issued=await(await f.issue()).json(),ticket=new URL('http://unused'+issued.path).hash.slice(8);
 const landing=await fetch(f.origin+'/__opencraft_preview/');assert.equal(landing.status,200);
 const source=await landing.text();assert.ok(source.indexOf('history.replaceState')<source.indexOf('await fetch'));
 const results=await Promise.all([f.redeem(ticket),f.redeem(ticket)]);assert.deepEqual(results.map(x=>x.status).sort(),[200,410]);
});

test('expired tickets, expired sessions and revocation reject reads',async t=>{
 const f=await fixture(t),issued=await(await f.issue()).json(),ticket=new URL('http://unused'+issued.path).hash.slice(8);
 f.advance(101);assert.equal((await f.redeem(ticket)).status,410);
 const c=await capability(f);f.advance(1001);assert.equal((await fetch(f.origin+c.path,{headers:{Cookie:c.cookie}})).status,403);
 const d=await capability(f);f.revoke();assert.equal((await fetch(f.origin+d.path,{headers:{Cookie:d.cookie}})).status,403);
});

test('foreign redemption does not consume the ticket',async t=>{
 const f=await fixture(t),issued=await(await f.issue()).json(),ticket=new URL('http://unused'+issued.path).hash.slice(8);
 assert.equal((await f.post('/__opencraft_preview/redeem',{ticket},{Origin:'https://untrusted.invalid'})).status,403);
 assert.equal((await f.redeem(ticket)).status,200);
 assert.equal((await fetch(f.origin+'/__opencraft_preview/redeem')).status,405);
});

for(const remote of [false,true]) test(`${remote?'SSH':'local'} resources cannot escape the report through traversal or symlinks`,async t=>{
 const f=await fixture(t,false,remote);await mkdir(join(f.directory,'report'));
 const path=join(f.directory,'report','index.html');await writeFile(join(f.directory,'outside.png'),'private');
 await writeFile(path,'<img src="../outside.png">');assert.equal((await f.issue(path)).status,400);
 await symlink(join(f.directory,'outside.png'),join(f.directory,'report','linked.png'));
 await writeFile(path,'<img src="linked.png">');assert.equal((await f.issue(path)).status,400);
 await writeFile(path,'<img src="https://untrusted.invalid/image.png"><a href="https://untrusted.invalid/">link</a>');
 const issued=await f.issue(path);assert.equal(issued.status,201);
 assert.equal((await f.issue(path,'unknown-host')).status,400);
});

test('report admission bounds bytes before buffering and service shutdown revokes capabilities',async t=>{
 const f=await fixture(t);await writeFile(f.report,Buffer.alloc(25*1024*1024+1));assert.equal((await f.issue()).status,400);
 await assert.rejects(f.files.readPreview('local-codex',f.directory,new AbortController().signal,1024));
});

test('real gateway preserves issuer admission while preview cookie never admits main APIs',async t=>{
 const f=await fixture(t,true);
 assert.equal((await f.issue()).status,201);
 assert.equal((await f.post('/__opencraft_preview/tickets',{hostId:'local-codex',path:f.report},{'x-test-actor':''})).status,401);
 assert.equal((await f.post('/__opencraft_preview/tickets',{hostId:'local-codex',path:f.report},{Origin:'https://untrusted.invalid'})).status,403);
 const c=await capability(f);
 assert.equal((await fetch(f.origin+c.path+'document',{headers:{Cookie:c.cookie}})).status,200);
 assert.equal((await fetch(f.origin+'/__opencraft_files?'+new URLSearchParams({hostId:'local-codex',path:f.report}),{headers:{Cookie:c.cookie}})).status,401);
 f.revoke();assert.equal((await fetch(f.origin+c.path,{headers:{Cookie:c.cookie}})).status,403);
});

test('managed supervisor forwards all preview routes to the authority backend',()=>{
 for(const path of ['/__opencraft_preview/','/__opencraft_preview/tickets','/__opencraft_preview/redeem','/__opencraft_preview/s/abc/document'])assert.equal(isHeadlessBackendPath(path),true);
 assert.equal(isHeadlessBackendPath('/__opencraft_preview-else'),false);
});
