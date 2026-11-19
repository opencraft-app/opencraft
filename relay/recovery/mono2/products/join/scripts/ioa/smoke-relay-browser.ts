import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { generateKeyPairSync, randomBytes, createHash, createCipheriv } from 'node:crypto';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import { createRelayServer } from '../../../../opencraft/apps/relay-server/src/server';
import { AssertionProvider, AssertionSigner } from '../../../../opencraft/packages/identity-core/src/node';
import { MembershipStore, InstanceAccess } from '../../../../opencraft/packages/access-control/src';
import { connectRelay } from '../../../../opencraft/plugins/relay-connect/src/server';
import { TencentOaServerPlugin } from '../../plugins/tencentoa/src/server';
import { createWorkbenchWebServer } from '../../../../opencraft/scripts/serve-workbench-web.mjs';

const dir=await mkdtemp(join(process.env.OPENCRAFT_RELAY_SMOKE_DIRECTORY ?? tmpdir(),'relay-browser-'));
const cleanups:(()=>unknown)[]=[];
try {
  const home=join(dir,'home'),nss=join(home,'.pki/nssdb');await mkdir(nss,{recursive:true});
  const command=(name:string,args:string[])=>execFileSync(name,args,{cwd:dir,stdio:'ignore'});
  command('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=OpenCraft isolated test CA','-keyout','ca.key','-out','ca.crt','-addext','basicConstraints=critical,CA:TRUE']);
  command('openssl',['req','-new','-newkey','rsa:2048','-nodes','-subj','/CN=login.relay.test','-keyout','server.key','-out','server.csr']);
  await writeFile(join(dir,'ext'), 'subjectAltName=DNS:login.relay.test,DNS:team-a.relay.test,DNS:team-b.relay.test,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n');
  command('openssl',['x509','-req','-in','server.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-days','1','-extfile','ext','-out','server.crt']);
  command('certutil',['-N','--empty-password','-d','sql:'+nss]);command('certutil',['-A','-d','sql:'+nss,'-n','OpenCraft isolated test CA','-t','C,,','-i',join(dir,'ca.crt')]);
  const pair=generateKeyPairSync('ed25519'),privateKey=pair.privateKey.export({format:'pem',type:'pkcs8'}).toString(),publicKey=pair.publicKey.export({format:'pem',type:'spki'}).toString();
  const token=Buffer.alloc(32,97),ioa=new TencentOaServerPlugin(token);cleanups.push(()=>ioa.close());
  const syntheticGateway=()=>{
    const timestamp=String(Math.floor(Date.now()/1000)),seq='isolated-browser',header=Buffer.from('{"alg":"dir","enc":"A256GCM"}').toString('base64url'),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',token,iv);cipher.setAAD(Buffer.from(header));
    const body=Buffer.concat([cipher.update(JSON.stringify({LoginName:'test.employee',StaffId:123,Expiration:new Date(Date.now()+60_000).toISOString()})),cipher.final()]);
    return {timestamp,'x-rio-seq':seq,signature:createHash('sha256').update(timestamp+token.toString()+seq+',,,'+timestamp).digest('hex').toUpperCase(),'x-tai-identity':[header,'',iv.toString('base64url'),body.toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.')};
  };
  let relay:ReturnType<typeof createRelayServer>;
  const tls=createServer({cert:await readFile(join(dir,'server.crt')),key:await readFile(join(dir,'server.key'))},(req,res)=>relay.server.emit('request',req,res));
  tls.on('upgrade',(req,socket,head)=>relay.server.emit('upgrade',req,socket,head));tls.listen(0,'127.0.0.1');await once(tls,'listening');
  cleanups.push(()=>new Promise<void>(resolve=>{tls.close(()=>resolve());tls.closeAllConnections();}));
  const port=(tls.address() as any).port,login=`https://login.relay.test:${port}`,routes=[],connections:ReturnType<typeof connectRelay>[]=[],stores:MembershipStore[]=[];
  for(const team of ['a','b']){
    const scope={issuer:'browser-test',instanceId:team,origin:`https://team-${team}.relay.test:${port}`};
    const store=new MembershipStore(join(dir,team+'.sqlite'));stores.push(store);cleanups.push(()=>store.close());store.set({provider:'tencentoa',subject:team==='a'?'123':'456'},'admin',true,'test-admin');
    const access=new InstanceAccess(store,[new AssertionProvider(scope,publicKey)]),root=join(dir,'web-'+team);await mkdir(root);await writeFile(join(root,'index.html'),`<!doctype html><title>Isolated team ${team}</title><h1>Team ${team}</h1>`);
    const web=await createWorkbenchWebServer({root,loopbackOnly:true,appServerTarget:null,accessService:access,desktopService:{accept(ws:any){ws.send('ready');ws.on('message',(data:any,binary:boolean)=>ws.send(data,{binary}));},close(){}}});
    cleanups.push(()=>web.close());const target=await web.listen({host:'127.0.0.1',port:0});routes.push({...scope,credential:randomBytes(32).toString('base64url'),signer:new AssertionSigner(scope,privateKey),identityProvider:ioa.identityProvider(),targetPort:target.port});
  }
  relay=createRelayServer(routes,{authentication:{origin:login,provider:{authenticate:req=>ioa.identityProvider().authenticate({headers:{...req.headers,...syntheticGateway()}})}}});cleanups.push(()=>relay.close());
  for(const route of routes)connections.push(connectRelay({relay:`https://127.0.0.1:${port}`,credential:route.credential,targetPort:route.targetPort,ca:await readFile(join(dir,'ca.crt'),'utf8')}));cleanups.push(()=>connections.forEach(c=>c.close()));
  const deadline=Date.now()+10_000;while(!routes.every(r=>relay.connected(r.instanceId))){if(Date.now()>deadline)throw new Error('TLS connector timeout');await new Promise(r=>setTimeout(r,25));}
  const browser=await chromium.launch({executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,env:{...process.env,HOME:home},args:['--no-sandbox','--no-proxy-server','--host-resolver-rules=MAP *.relay.test 127.0.0.1']});cleanups.push(()=>browser.close());
  const context=await browser.newContext(),page=await context.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const navigations:string[]=[];page.on('request',request=>{if(request.isNavigationRequest())navigations.push(new URL(request.url()).host);});
  await page.goto(routes[0]!.origin+'/');assert.equal(await page.title(),'Isolated team a');assert.ok(navigations.includes(new URL(login).host));
  const session=await page.evaluate(()=>fetch('/__opencraft_access/session').then(r=>r.json()));assert.equal(session.role,'admin');assert.equal(session.principal.subject,'123');
  const cookies=await context.cookies();assert.ok(cookies.some(c=>c.name==='__Host-opencraft-relay-session'&&c.httpOnly&&c.secure&&c.domain==='team-a.relay.test'));
  await page.evaluate(()=>new Promise<void>((resolve,reject)=>{const ws=new WebSocket(location.origin.replace('https:','wss:')+'/desktop/connect');(window as any).relaySocket=ws;ws.onmessage=()=>resolve();ws.onerror=()=>reject(new Error('WebSocket failed'));}));
  const revoked=page.evaluate(()=>new Promise<number>(resolve=>{(window as any).relaySocket.onclose=(event:CloseEvent)=>resolve(event.code);}));stores[0]!.set({provider:'tencentoa',subject:'123'},'member',false,'test-admin');const revokedCode=await revoked;assert.ok([1006,1008].includes(revokedCode));
  await page.reload();assert.equal(await page.getByRole('heading',{name:'暂时无法访问'}).count(),1);
  stores[0]!.set({provider:'tencentoa',subject:'123'},'admin',true,'test-admin');await page.reload();assert.equal(await page.title(),'Isolated team a');
  await page.goto(routes[1]!.origin+'/');assert.equal(await page.getByRole('heading',{name:'暂时无法访问'}).count(),1,'employee is not a member of team b');
  assert.deepEqual(errors,[]);await page.screenshot({path:join(dir,'team-b-denied.png')});
  await writeFile(join(dir,'evidence.json'),JSON.stringify({tlsVerified:true,ioABoundary:'synthetic signed IOA at isolated authentication gateway only',teamOrigins:routes.map(r=>r.origin),browserHandoff:true,hostOnlySecureCookie:true,coreRole:true,webSocket:true,revocationClose:revokedCode,crossTeamDenied:true,pageErrors:errors},null,2));
  console.log('Relay browser HTTPS/auth/cookie/WS/revocation checks passed; evidence: '+dir);
} finally {for(const close of cleanups.reverse())await close();if(process.env.OPENCRAFT_RELAY_SMOKE_CLEAN==='1')await rm(dir,{recursive:true,force:true});}
