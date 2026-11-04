import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:net';
import {dirname,join} from 'node:path';
import {CodexCoreControlClient} from '@opencraft/account-pool-host';
import {startCodexCore,type CodexCoreOptions} from '../../apps/codex-core/src/main';
import {startControlServer,readControlJson} from '../../apps/codex-core/src/control-server';
import {CodexGenerationRuntime} from '../../apps/codex-core/src/generation-runtime';
import {CodexGenerationRouter,startGenerationSocket} from '../../apps/codex-core/src/generation-router';

/** Isolated accounts -> generation router -> separate fixed APP -> stock Native.
 * Only the process supervisor and model/auth upstream are local test adapters.
 * Never contacts systemd or opens a deployment's sockets/configuration. */
export async function startSplitCoreFixture(options:CodexCoreOptions,appBundle:string){
 const root=options.runtimeDirectory,tokenFile=join(root,'split-token'),routerEndpoint=join(root,'routing.sock');
 const generationHome=dirname(options.nativeCodexHomeDirectory!);
 await mkdir(join(generationHome,'runtime'),{recursive:true,mode:0o700});await writeFile(tokenFile,options.authToken,{mode:0o600});
 const reservation=createServer();await new Promise<void>(r=>reservation.listen(0,'127.0.0.1',r));
 const port=(reservation.address() as import('node:net').AddressInfo).port;await new Promise<void>(r=>reservation.close(()=>r()));
 const cliSha256=createHash('sha256').update(await readFile(options.executable)).digest('hex');
 let core:Awaited<ReturnType<typeof startCodexCore>>|undefined,control:any,listener:any,runtime:CodexGenerationRuntime|undefined,child:ChildProcess|undefined;
 const stamp=async(pid:number)=>String((await readFile(`/proc/${pid}/stat`,'utf8')).split(') ')[1]!.split(' ')[19]);
 const stopPhysical=async()=>{const owned=child;if(!owned||owned.exitCode!==null||owned.signalCode!==null){child=undefined;return;}await new Promise<void>(resolve=>{const timer=setTimeout(()=>owned.kill('SIGKILL'),5000);owned.once('exit',()=>{clearTimeout(timer);resolve();});owned.kill('SIGTERM');});child=undefined;};
 const close=async()=>{try{await control?.close();await listener?.close();await runtime?.close();}finally{await stopPhysical();await core?.close();}};
 try{
  core=await startCodexCore({...options,appServerEndpoint:routerEndpoint,proxyPort:port});
  runtime=new CodexGenerationRuntime({directory:join(root,'registry'),dataDirectory:options.dataDirectory,proxyBaseUrl:`http://127.0.0.1:${port}`,requireHostUsage:true,replaceRetiredHome:async()=>{throw Error('Fixture never replaces retained HOME');},supervisor:{
   async start(g){
    if(!child||child.exitCode!==null||child.signalCode!==null){
     const owned=spawn(process.execPath,[appBundle,'--endpoint',g.endpoint,'--core-endpoint',options.endpoint,'--token-file',tokenFile,'--data-directory',options.dataDirectory,'--runtime-directory',root,'--runtime-data-directory',generationHome,'--codex-executable',options.executable],{cwd:root,stdio:['ignore','pipe','pipe']});child=owned;
     // The official APP discards Native stderr; do not turn its private output into test evidence.
     owned.stderr!.resume();
     await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Isolated APP initialization timed out')),15000);owned.once('error',e=>{clearTimeout(timer);reject(e);});owned.once('exit',()=>{clearTimeout(timer);reject(Error('Isolated APP exited before readiness'));});owned.stdout!.on('data',(v:Buffer)=>{if(v.toString().includes('codex-app-server-ready')){clearTimeout(timer);resolve();}});});
    }
    return new CodexCoreControlClient(g.endpoint,options.authToken).appServerHealth();
   },
   async identify(g,h){return{ownerPid:h.pid,nativePid:h.codexPid,ownerStart:await stamp(h.pid),nativeStart:await stamp(h.codexPid),cliSha256,cliVersion:'codex-cli 0.162.1',unit:'isolated-subprocess'};},
   async stop(){await stopPhysical();},async discardUnready(){await stopPhysical();},async processesQuiet(){return !child||child.exitCode!==null||child.signalCode!==null;},
  }});
  const router=new CodexGenerationRouter(runtime);runtime.serverRequestCount=id=>router.serverRequestCount(id);
  const socket=join(root,'routed-native.sock');listener=await startGenerationSocket(socket,router);
  control=await startControlServer(routerEndpoint,options.authToken,async req=>{
   if(req.url==='/health'){const current=runtime!.registry.current(),h=await runtime!.ensure(current.generation.id);return{status:200,value:{...h,nativeSocket:socket,routingEpoch:runtime!.registry.ownerEpoch,routingPid:process.pid,orchestrationRoutingVersion:1,callbackProtocolVersion:1}};}
   if(req.url?.split('?')[0]==='/generation-directory'){const query=new URL(req.url,'http://fixture.invalid');return{status:200,value:await runtime!.generationDirectory(query.searchParams.get('threadId')??undefined)};}
   const e=await readControlJson(req),p=e.params as any;
   assert.equal(req.url,'/generation-host');
   return{status:200,value:e.operation==='claim'?runtime!.claimHost(p.instanceId,p.routingEpoch):runtime!.publishHostUsage(p)};
  });
  await runtime.prepare({id:'fixture',endpoint:join(root,'app.sock'),runtimeDataDirectory:generationHome,executable:options.executable,bundle:appBundle,node:process.execPath,cwd:root});await runtime.activate('fixture',0);
  return{endpoint:options.endpoint,close,async restartPhysical(){await stopPhysical();await runtime!.ensure('fixture',false,true);}};
 }catch(e){await close();throw e;}
}
