import { createServer, request } from 'node:http';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import WebSocket from 'ws';
import { AssertionProvider, AssertionSigner, ASSERTION_HEADER } from '../../packages/identity-core/src/node';
import { MembershipStore, InstanceAccess } from '../../packages/access-control/src';
import type { EntryOriginResolver } from '../../apps/relay-server/src/authentication';
import { createRelayServer } from '../../apps/relay-server/src/server';
import { selectionIdentity, type ServerPaths } from '../../apps/relay-server/src/selection';
import { connectRelay } from '../../plugins/relay-connect/src/server';
import { SshManagement } from '../../apps/opencraft-daemon/src/ssh-management';
import { FixtureRequestIdentity } from './request-identity';
import { createWorkbenchWebServer } from '../../scripts/serve-workbench-web.mjs';

export async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline=Date.now()+8000;
  while(!await check()) { if(Date.now()>deadline) throw new Error('Fixture condition timeout'); await new Promise(r=>setTimeout(r,20)); }
}
export async function virtualFetch(url:string, init:{headers?:Record<string,string>;method?:string;body?:Buffer}={}) {
  return new Promise<Response>((resolve,reject)=>{
    const req=request(url,{method:init.method??'GET',headers:init.headers},res=>{
      const headers=new Headers();for(let i=0;i<res.rawHeaders.length;i+=2)headers.append(res.rawHeaders[i]!,res.rawHeaders[i+1]!);
      resolve(new Response([204,304].includes(res.statusCode!)?null:Readable.toWeb(res) as ReadableStream<Uint8Array>,{status:res.statusCode,headers}));
    });req.on('error',reject);req.end(init.body);
  });
}
export async function selectorFixture(options:{entryOrigin?:EntryOriginResolver;appServerTarget?:string;webRoot?:string;appHost?:()=>unknown;defaultUsers?:readonly string[];legacyDefaultUsers?:readonly string[];entryName?:string;sshPublicAccess?:boolean;serverPaths?:ServerPaths}={}) {
  const directory=await mkdtemp(join(tmpdir(),'server-selector-')),cleanup:(()=>unknown)[]=[];
  cleanup.push(()=>rm(directory,{recursive:true,force:true}));
  const pair=generateKeyPairSync('ed25519'),privateKey=pair.privateKey.export({format:'pem',type:'pkcs8'}).toString(),publicKey=pair.publicKey.export({format:'pem',type:'spki'}).toString();
  const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=(reserve.address() as any).port;await new Promise<void>(r=>reserve.close(()=>r()));
  const base=`http://127.0.0.1:${port}`,origin=`http://entry.selection.test:${port}`,host=new URL(origin).host;
  const principals=Object.fromEntries(['alice','bob','carol'].map((name,index)=>[name,{provider:'enterprise-identity',subject:String(101+index),displayName:name,aliases:['login:'+name],attributes:{loginName:name},expiresAt:Date.now()+3600_000}]));
  const provider={authenticate:(req:any)=>principals[String(req.headers['x-fixture-user'])]??null};
  const routes:any[]=[],stores:MembershipStore[]=[],clients:ReturnType<typeof connectRelay>[]=[],targets:any[]=[];
  for(const id of ['join','lighthouse']) {
    const scope={issuer:'isolated-fixture',instanceId:id,origin:id==='join'?origin:`http://lighthouse.selection.test:${port}`};
    const store=new MembershipStore(join(directory,id+'.sqlite'));stores.push(store);cleanup.push(()=>store.close());
    const grants=id==='join'?{alice:'admin',bob:'member'}:{alice:'member',carol:'admin'};
    for(const [subject,role] of Object.entries(grants))store.set(principals[subject]!,role as 'admin'|'member',true,'fixture-administrator');
    const access=new InstanceAccess(store,[new AssertionProvider(scope,publicKey)]);
    const root=options.webRoot??join(directory,id);if(!options.webRoot){await mkdir(root);await writeFile(join(root,'index.html'),`<!doctype html><html><head><title>${id}</title></head><body><h1>${id}</h1><a id="switch" href="/servers">切换服务器</a></body></html>`);}
    const oa=new FixtureRequestIdentity(req=>access.authenticate(req));cleanup.push(()=>oa.close());
    const appHost=options.appHost?.();if(appHost)cleanup.push(()=>(appHost as any).close());
    const sshManagement=options.sshPublicAccess === undefined ? null : new SshManagement({directory:join(directory,id+'-ssh'),publicAccess:options.sshPublicAccess,resetConnection:async()=>{},connectConnection:async()=>{}});
    if(sshManagement)cleanup.push(()=>sshManagement.close());
    const web=await createWorkbenchWebServer({root,sshManagement,appHostServer:appHost,appServerTarget:options.appServerTarget??null,loopbackOnly:false,desktopAccess:'trusted-internal',accessService:access,identityService:oa,
      desktopService:{accept(ws:WebSocket){ws.send('connected-'+id);ws.on('message',(data,binary)=>ws.send(data,{binary}));},close(){}}});cleanup.push(()=>web.close());
    const address=await web.listen({host:'127.0.0.1',port:0});
    // Business streaming endpoint behind the same target authorization; no identity bypass.
    const target=createServer(async(req,res)=>{
      const fixturePath = (req.url ?? '/').split('?')[0];
      if(fixturePath==='/fixture/headers'||fixturePath==='/fixture/upload'||fixturePath==='/fixture/stream'||fixturePath==='/fixture/compressed.html'){
        const status=access.admissionStatus(req);if(status!==204){res.writeHead(status);res.end();return;}
        if(fixturePath==='/fixture/compressed.html'){res.writeHead(200,{'content-type':'text/html','content-encoding':'gzip'});res.end(gzipSync('<html><head><title>Compressed</title></head><body>Compressed document</body></html>'));return;}
        if(fixturePath==='/fixture/headers'){res.setHeader('content-type','application/json');res.end(JSON.stringify({id,cookie:req.headers.cookie??null,assertion:typeof req.headers[ASSERTION_HEADER]==='string',origin:req.headers.origin??null}));return;}
        if(fixturePath==='/fixture/stream'){res.writeHead(200,{'content-type':'text/event-stream','set-cookie':'private-target=not-shared; HttpOnly'});res.write('first\n');setTimeout(()=>res.end('last\n'),250);return;}
        let size=0;const hash=createHash('sha256');for await(const data of req){size+=data.length;hash.update(data);}res.end(JSON.stringify({size,hash:hash.digest('hex')}));return;
      }
      const upstream=request(`http://127.0.0.1:${address.port}${req.url}`,{method:req.method,headers:req.headers},result=>{res.writeHead(result.statusCode!,result.headers);result.pipe(res);});upstream.on('error',()=>res.destroy());req.pipe(upstream);
    });
    // The frontend forwards HTTP only; real WS is tunnelled directly to the core.
    const { createHeadlessBackendProxy }=await import('../../scripts/web-deployment/headless-backend.mjs');
    const proxy=createHeadlessBackendProxy(`http://127.0.0.1:${address.port}`);target.on('upgrade',(req,socket,head)=>proxy.upgrade(req,socket,head,()=>{},new Set()));
    target.listen(0,'127.0.0.1');await once(target,'listening');cleanup.push(()=>new Promise<void>(r=>{target.close(()=>r());target.closeAllConnections();}));
    const route={...scope,name:id==='join'?(options.entryName??'Server'):'Lighthouse',credential:randomBytes(32).toString('base64url'),signer:new AssertionSigner(scope,privateKey),identityProvider:provider};routes.push(route);targets.push((target.address() as any).port);
  }
  const relay=createRelayServer(routes,{authentication:{origin,provider},serverSelection:true,entryOrigin:options.entryOrigin,serverPaths:options.serverPaths,selectionDefaults:new Map([...(options.defaultUsers??[]).map(name=>[selectionIdentity(principals[name]!), 'join'] as const),...(options.legacyDefaultUsers??[]).map(name=>[selectionIdentity({provider:'enterprise-identity',subject:'login:'+name}), 'join'] as const)])});relay.server.listen(port,'127.0.0.1');await once(relay.server,'listening');cleanup.push(()=>relay.close());
  for(let i=0;i<routes.length;i++)clients.push(connectRelay({relay:base,credential:routes[i]!.credential,targetPort:targets[i],allowLoopbackInsecure:true}));cleanup.push(()=>clients.forEach(c=>c.close()));
  await waitFor(()=>routes.every(r=>relay.connected(r.instanceId)));
  const get=(path:string,headers:Record<string,string>={},method='GET',body?:Buffer)=>virtualFetch(base+path,{headers:{host,...headers},method,body});
  const login=async(user:string)=>{
    const start=await get('/',{accept:'text/html'}),challenge=start.headers.getSetCookie()[0]!.split(';')[0]!;
    const loginUrl=new URL(start.headers.get('location')!),verified=await get(loginUrl.pathname+loginUrl.search,{'x-fixture-user':user});
    const callback=new URL(verified.headers.get('location')!),session=await get(callback.pathname+callback.search,{cookie:challenge});
    return session.headers.getSetCookie().find(c=>c.startsWith('opencraft-relay-session='))!.split(';')[0]!;
  };
  return {base,origin,host,principals,stores,clients,relay,get,login,async close(){for(const close of cleanup.reverse())await close();}};
}
