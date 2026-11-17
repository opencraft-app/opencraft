import {createServer,type Server} from 'node:http';
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {mkdir,writeFile,unlink,access} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocket,WebSocketServer} from 'ws';
import type {OnboardingAgentSnapshot} from '@opencraft/appserver-protocol';
import type {OnboardingDeps} from './agent-onboarding.js';
type Value=Record<string,any>;
/** Authenticated, loopback-only rendezvous. Native commands stay inside IDE. */
export class CodeBuddyIdeBridge {
  readonly descriptor:string;
  private server?:Server;
  private readonly sockets=new WebSocketServer({noServer:true,maxPayload:2*1024*1024});
  private readonly ideToken=randomBytes(32).toString('hex');
  private readonly proxyToken=randomBytes(32).toString('hex');
  private ide?:WebSocket;
  private readonly pending=new Map<string,{resolve(value:Value):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>();
  private hello?:Value;
  private url?:string;
  private link:string|null=null;
  private closed=false;
  private enabled=true;
  constructor(private readonly directory:string,private readonly deps:OnboardingDeps){this.descriptor=join(directory,'codebuddy-ide-bridge.json');}
  async start(){
    if(this.server)return;
    const server=createServer((_request,response)=>response.writeHead(404).end());this.server=server;
    server.on('upgrade',(request,socket,head)=>{
      const token=String(request.headers.authorization??'').replace(/^Bearer /,'');
      const received=Buffer.from(token);
      const equal=(expected:string)=>received.length===Buffer.byteLength(expected)&&timingSafeEqual(received,Buffer.from(expected));
      const ide=request.url==='/ide'&&equal(this.ideToken),proxy=request.url==='/proxy'&&equal(this.proxyToken);
      if((!ide&&!proxy)||request.headers.origin!==undefined||this.closed||!this.enabled){socket.destroy();return;}
      this.sockets.handleUpgrade(request,socket,head,ws=>{
        if(ide){
          if(this.ide){ws.close(1008,'Another IDE is already connected');return;}
          this.ide=ws;ws.once('close',()=>{if(this.ide===ws){this.ide=undefined;this.hello=undefined;for(const task of this.pending.values()){clearTimeout(task.timer);task.reject(new Error('IDE disconnected; check the original conversation before retrying'));}this.pending.clear();}});
          ws.on('message',bytes=>{try{const packet=JSON.parse(String(bytes));if(packet.kind==='hello'&&packet.version===1&&typeof packet.status?.authenticated==='boolean')this.hello=packet.status;
            if(packet.kind==='response'&&typeof packet.id==='string'){const task=this.pending.get(packet.id);if(!task)return;this.pending.delete(packet.id);clearTimeout(task.timer);packet.error||!packet.result||typeof packet.result!=='object'||Array.isArray(packet.result)?task.reject(new Error('IDE operation was not confirmed')):task.resolve(packet.result);}
          }catch{ws.close(1008);}});
        }else{
          ws.on('message',bytes=>{void(async()=>{let packet;try{packet=JSON.parse(String(bytes));if(typeof packet.id!=='string'||!['describe','new','resume','prompt'].includes(packet.method))throw new Error('Invalid IDE operation');const result=await this.call(packet.method,packet.params);if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({id:packet.id,result}));}catch{if(ws.readyState===WebSocket.OPEN&&packet?.id)ws.send(JSON.stringify({id:packet.id,error:'IDE operation was not confirmed. Check the native conversation before retrying.'}));}})();});
        }
        ws.on('error',()=>{});
      });
    });
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address();if(!address||typeof address==='string')throw new Error('IDE bridge address missing');
    this.url='ws://127.0.0.1:'+address.port;
    await mkdir(this.directory,{recursive:true,mode:0o700});
    await writeFile(this.descriptor,JSON.stringify({version:1,url:this.url+'/ide',ideToken:this.ideToken,proxyToken:this.proxyToken}),{mode:0o600});
  }
  async historyScope():Promise<Value>{const result=await this.call('describe');this.hello=result;if(result.authenticated!==true||result.workspaceTrusted!==true||typeof result.userId!=='string'||typeof result.cwd!=='string'||!result.cwd.startsWith('/'))throw new Error('Connect the signed-in IDE project before importing');return {userId:result.userId,cwd:result.cwd,currentSessionId:result.currentSessionId};}
  async workspace():Promise<string>{const result=await this.call('describe');if(typeof result.cwd!=='string'||!result.cwd.startsWith('/'))throw new Error('Open a project in CodeBuddy IDE');return result.cwd;}
  private call(method:string,params:Value={}):Promise<Value>{
    if(!this.ide||this.ide.readyState!==WebSocket.OPEN||!this.hello)return Promise.reject(new Error('Connect CodeBuddy IDE first'));
    if(this.pending.size>=32)return Promise.reject(new Error('IDE bridge busy'));
    const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('IDE outcome unknown; check the original conversation'));},method==='prompt'?330000:15000);this.pending.set(id,{resolve,reject,timer});this.ide!.send(JSON.stringify({kind:'request',id,method,params}));});
  }
  async snapshot(cached=false):Promise<OnboardingAgentSnapshot>{
    const launcher=await this.launcher();
    const status=this.hello?(cached?this.hello:await this.call('describe').catch(()=>null)):null;
    if(status)this.hello=status;
    return {id:'codebuddy-ide',engineId:'codebuddy-ide',displayName:'CodeBuddy IDE',installed:!!launcher||!!status,version:null,
      connectionRequired:!status,workspaceTrusted:status?.workspaceTrusted,authenticated:typeof status?.authenticated==='boolean'?status.authenticated:null,account:typeof status?.account==='string'?status.account:null,
      installUrl:'https://www.codebuddy.cn/ide/',canInstallPackage:false,historyImport:typeof status?.userId==='string'&&status.userId.length>0,
      ...(typeof status?.userId==='string'&&status.userId.length>0 ? {historyScope:createHash('sha256').update(JSON.stringify([status.userId,status.cwd])).digest('hex')} : {}),
      activity:this.link&&!status?{kind:'sign-in',phase:'running',message:null,url:this.link,userCode:null,log:''}:null};
  }
  async act(action:unknown){
    if(action==='cancel'){this.link=null;this.enabled=false;this.ide?.close();return;}
    if(action!=='sign-in')throw new Error('Unsupported IDE setup action');
    this.enabled=true;
    if(this.hello){const state=await this.call('describe');await this.call(state.workspaceTrusted===false?'trust':'sign-in');return;}
    const launcher=await this.launcher();if(!launcher)throw new Error('Install CodeBuddy IDE first');
    const root=fileURLToPath(new URL('../../../',import.meta.url));
    const build=await this.deps.exec(process.execPath,[join(root,'scripts/build-codebuddy-ide-extension.mjs'),join(this.directory,'extension'),this.descriptor],120000,this.deps.env);
    if(build.code!==0)throw new Error('Could not prepare the IDE bridge extension');
    const install=await this.deps.exec(launcher,['--install-extension',join(this.directory,'extension/opencraft-codebuddy-ide.vsix'),'--force'],120000,this.deps.env);
    if(install.code!==0)throw new Error('CodeBuddy IDE could not install the bridge extension');
    this.link='codebuddycn://opencraft.codebuddy-ide/connect?descriptor='+encodeURIComponent(this.descriptor);
  }
  private async launcher():Promise<string|null>{
    if(process.platform!=='darwin')return null;
    for(const app of ['CodeBuddy CN.app','CodeBuddy.app']){const path=join('/Applications',app,'Contents/Resources/app/bin/code');try{await access(path);return path;}catch{}}
    return null;
  }
  async close(){this.closed=true;for(const task of this.pending.values()){clearTimeout(task.timer);task.reject(new Error('IDE bridge closed'));}this.pending.clear();for(const socket of this.sockets.clients)socket.terminate();this.sockets.close();await new Promise<void>(resolve=>this.server?this.server.close(()=>resolve()):resolve());await unlink(this.descriptor).catch(()=>{});}
}
