import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {request as httpsRequest} from 'node:https';
import {createReadStream} from 'node:fs';
import {readFile} from 'node:fs/promises';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Duplex} from 'node:stream';
import {WebSocketServer,WebSocket} from 'ws';
import {relayDuplex} from '@opencraft/relay-protocol/node';
import {CONTROL_PATH,DATA_PATH,STREAM_HEADER,RELAY_PROTOCOL,isPrivateIpv4Address} from '@opencraft/relay-protocol';
import {PersonalMachineStore} from './personal-machines-store.js';
import type {PersonalMachineCommand,PersonalMachinesDirectory} from '@opencraft/appserver-protocol/personal-machines';
const prefix='/__opencraft_machines';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const bearer=(r:IncomingMessage)=>/^Bearer ([A-Za-z0-9_-]{32,64})$/.exec(r.headers.authorization??'')?.[1]??'';
const quote=(v:string)=>"'"+v.replace(/'/g,"'\\''")+"'";
export function personalMachineOrigin(value:unknown){
  if(typeof value!=='string')throw new Error('Remote machine requires an origin');const u=new URL(value);
  if(u.origin!==value||u.username||u.password||u.protocol!=='https:'&&!(u.protocol==='http:'&&(['127.0.0.1','localhost'].includes(u.hostname)||isPrivateIpv4Address(u.hostname))))throw new Error('Remote machine requires HTTPS');return u.origin;
}
/** Deployment-owned callback address; never derive it from a browser's loopback URL. */
export function personalMachineEnrollmentOrigin(value:unknown){
  const origin=personalMachineOrigin(value),url=new URL(origin),host=url.hostname.toLowerCase().replace(/\.$/,'');
  if(host==='localhost'||host.endsWith('.localhost')||host==='0.0.0.0'||host==='[::]'||host==='[::1]'||/^127\./.test(host)||host.startsWith('[::ffff:'))throw new Error('Remote enrollment requires a reachable Server origin');
  return origin;
}
const json=(r:ServerResponse,status:number,value:unknown)=>{r.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});r.end(JSON.stringify(value));};
const body=async(r:IncomingMessage)=>{let text='';for await(const c of r){text+=c;if(Buffer.byteLength(text)>16384)throw new Error('Request too large');}return JSON.parse(text);};
interface Connection {socket:WebSocket;streams:Set<Duplex>}
export class PersonalMachines {
  readonly store:PersonalMachineStore;
  private sockets=new WebSocketServer({noServer:true,maxPayload:65536,perMessageDeflate:false});
  private connections=new Map<string,Connection>();
  private pending=new Map<string,{token:string;connection:Connection;accept(ws:WebSocket):void;reject():void}>();
  private closed=false;private closeOperation?:Promise<void>;private downloads=new Set<ServerResponse>();
  constructor(private options:{directory:string;ownerActorId:string;ownerToken:string;archive:string;digest:string;installer:string;enrollmentOrigin?:string;enrollmentCa?:string}){
    if(options.enrollmentOrigin)personalMachineEnrollmentOrigin(options.enrollmentOrigin);
    this.store=new PersonalMachineStore(options.directory,options.ownerActorId,()=>{this.closed=true;for(const[id,c]of this.connections)this.retire(id,c);});
  }
  async ready(){await this.store.ready;}
  directory():PersonalMachinesDirectory{return {hubId:this.store.state.hubId,ownerActorId:this.store.state.ownerActorId,enrollmentOrigin:this.options.enrollmentOrigin??null,machines:this.store.state.machines.filter(r=>r.credentialHash||r.expiresAt>Date.now()).map(r=>({id:r.id,name:r.machine?.name??'',machine:r.machine,connected:this.connections.has(r.id),phase:r.credentialHash?'enrolled':'pending',expiresAt:r.credentialHash?null:r.expiresAt}))};}
  async command(input:PersonalMachineCommand){
    if(!input||typeof input!=='object'||(this.closed||!this.store.available))throw new Error('Machine service unavailable');
    if(input.action==='list')return this.directory();
    if(input.action==='create'){
      if(Object.keys(input).some(key=>key!=='action'))throw new Error('Enrollment address belongs to the Server');
      const origin=personalMachineEnrollmentOrigin(this.options.enrollmentOrigin);
      const reachable=this.options.enrollmentCa ? await new Promise<boolean>((resolve,reject)=>{const req=httpsRequest(origin+prefix+'/install.sh',{ca:this.options.enrollmentCa,timeout:10000},res=>{resolve(res.statusCode===200&&res.headers['x-opencraft-machine-hub']===this.store.state.hubId);res.resume();});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Enrollment probe timeout')));req.end();}) : await (async()=>{const probe=await fetch(origin+prefix+'/install.sh',{redirect:'error',signal:AbortSignal.timeout(10000)});await probe.body?.cancel();return probe.ok&&probe.headers.get('x-opencraft-machine-hub')===this.store.state.hubId;})();
      if(!reachable)throw new Error('Remote enrollment entrance is unavailable');
      const secret=randomBytes(32).toString('base64url');
      const state=await this.store.command('create',{pairHash:hash(secret)}),row=state.machines.at(-1)!;
      const bootstrap=JSON.stringify({schemaVersion:1,origin,hubId:state.hubId,id:row.id,secret,digest:this.options.digest,...(this.options.enrollmentCa?{ca:this.options.enrollmentCa}:{})});
      if(!this.options.enrollmentCa)return {...this.directory(),machineId:row.id,command:`bash -o pipefail -c ${quote('curl -fsS '+origin+prefix+'/install.sh | bash -s -- '+secret)}`};
      return {...this.directory(),machineId:row.id,command:`OPENCRAFT_MACHINE_BOOTSTRAP=${quote(bootstrap)} bash -c ${quote('set -euo pipefail; curl --fail --silent --show-error --location --max-redirs 0 '+(this.options.enrollmentCa?'--cacert <(printf %s '+quote(Buffer.from(this.options.enrollmentCa).toString('base64'))+' | base64 -d) ':'')+quote(origin+prefix+'/install.sh')+' | bash')}`};
    }
    if(input.action==='revoke'){
      if(typeof input.id!=='string')throw new Error('Invalid machine');
      await this.store.command('revoke',{id:input.id});const connection=this.connections.get(input.id);if(connection)this.retire(input.id,connection);return this.directory();
    }
    throw new Error('Unknown machine action');
  }
  async http(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
    const url=new URL(req.url??'/','http://localhost');if(!url.pathname.startsWith(prefix))return false;
    try{
      await this.ready();if(this.closed||!this.store.available)throw new Error("Machine service unavailable");
      if(req.method==='GET'&&url.pathname===prefix+'/install.sh'){
        if(url.searchParams.get('module')==='update'){
          const row=this.store.state.machines.find(r=>r.id===url.searchParams.get('id')&&r.credentialHash===hash(bearer(req)));
          if(!row){json(res,403,{error:'update_unavailable'});return true;}
          res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(await readFile(new URL('../../../scripts/personal-machine/update.mjs',import.meta.url)));return true;
        }
        res.writeHead(200,{'content-type':'text/x-shellscript','cache-control':'no-store','x-opencraft-machine-hub':this.store.state.hubId});res.end('export OPENCRAFT_MACHINE_ORIGIN='+quote(this.options.enrollmentOrigin??'')+'\n'+await readFile(this.options.installer,'utf8'));return true;
      }
      if(url.searchParams.get('update')==='1'&&req.method==='GET'&&(url.pathname===prefix+'/bootstrap'||url.pathname===prefix+'/source.tgz')){
        const row=this.store.state.machines.find(r=>r.id===url.searchParams.get('id')&&r.credentialHash===hash(bearer(req)));
        if(!row){json(res,403,{error:'update_unavailable'});return true;}
        if(url.pathname===prefix+'/bootstrap'){json(res,200,{schemaVersion:1,origin:this.options.enrollmentOrigin,hubId:this.store.state.hubId,id:row.id,digest:this.options.digest});return true;}
        res.writeHead(200,{'content-type':'application/gzip','cache-control':'no-store'});this.downloads.add(res);const source=createReadStream(this.options.archive);source.on('error',()=>res.destroy());res.once('close',()=>{this.downloads.delete(res);source.destroy();});source.pipe(res);return true;
      }
      if(url.pathname===prefix+'/status'&&req.method==='GET'&&hash(bearer(req))===hash(this.options.ownerToken)){json(res,200,this.directory());return true;}
      const secret=bearer(req);
      if(url.pathname===prefix+'/bootstrap'&&req.method==='GET'){
        const row=this.store.state.machines.find(r=>r.pairHash===hash(secret)&&!r.credentialHash&&r.expiresAt>Date.now());
        if(!row){json(res,403,{error:'pairing_unavailable'});return true;}
        json(res,200,{schemaVersion:1,origin:personalMachineEnrollmentOrigin(this.options.enrollmentOrigin),hubId:this.store.state.hubId,id:row.id,secret,digest:this.options.digest});return true;
      }
      const id=url.searchParams.get('id'),row=this.store.state.machines.find(r=>r.id===id&&r.pairHash===hash(secret));
      if(!row){json(res,403,{error:'pairing_unavailable'});return true;}
      if(url.pathname===prefix+'/source.tgz'&&req.method==='GET'&&!row.credentialHash&&row.expiresAt>Date.now()){
        res.writeHead(200,{'content-type':'application/gzip','cache-control':'no-store'});this.downloads.add(res);const source=createReadStream(this.options.archive);res.once('close',()=>this.downloads.delete(res));source.on('error',()=>res.destroy());source.pipe(res);res.once('close',()=>source.destroy());return true;
      }
      if(url.pathname===prefix+'/enroll'&&req.method==='POST'){
        const input=await body(req);await this.store.command('claim',{id,pairHash:hash(secret),credentialHash:input.credentialHash,machine:input.machine});json(res,200,{id,hubId:this.store.state.hubId});return true;
      }
      json(res,403,{error:'pairing_unavailable'});
    }catch{if(!res.headersSent)json(res,403,{error:'pairing_unavailable'});else res.destroy();}return true;
  }
  private retire(id:string,c:Connection){
    if(this.connections.get(id)===c)this.connections.delete(id);c.socket.terminate();for(const stream of c.streams)stream.destroy();
    for(const p of this.pending.values())if(p.connection===c)p.reject();
  }
  upgrade(req:IncomingMessage,socket:Duplex,head:Buffer):boolean{
    const url=new URL(req.url??'/','http://localhost');
    const reject=()=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    if(url.pathname===CONTROL_PATH){
      const row=this.store.state?.machines.find(r=>r.credentialHash===hash(bearer(req)));
      if(!row||this.closed||!this.store.available||req.headers.origin||req.headers['sec-websocket-protocol']!==RELAY_PROTOCOL){reject();return true;}
      this.sockets.handleUpgrade(req,socket,head,ws=>{
        const previous=this.connections.get(row.id);if(previous)this.retire(row.id,previous);
        const c={socket:ws,streams:new Set<Duplex>()};this.connections.set(row.id,c);
        const heartbeat=setInterval(()=>{if(ws.readyState===WebSocket.OPEN)ws.ping();},15000);heartbeat.unref();let pong=Date.now();ws.on('pong',()=>{pong=Date.now();});
        const expire=setInterval(()=>{if(Date.now()-pong>45000)ws.terminate();},15000);expire.unref();
        ws.on('error',()=>{});ws.once('close',()=>{clearInterval(heartbeat);clearInterval(expire);this.retire(row.id,c);});
      });return true;
    }
    if(url.pathname===DATA_PATH){
      const id=String(req.headers[STREAM_HEADER]??''),p=this.pending.get(id);
      if(!p||p.token!==bearer(req)||req.headers.origin||this.closed){reject();return true;}
      this.pending.delete(id);this.sockets.handleUpgrade(req,socket,head,ws=>p.accept(ws));return true;
    }
    const match=new RegExp('^'+prefix+'/([a-f0-9-]{36})/rpc$').exec(url.pathname);
    if(!match)return false;
    if(this.closed||!this.store.available||hash(bearer(req))!==hash(this.options.ownerToken)){reject();return true;}
    const c=this.connections.get(match[1]!);
    if(!c||c.streams.size>=128||this.pending.size>=128){reject();return true;}
    const id=randomUUID(),token=randomBytes(32).toString('base64url');
    const cleanup=()=>{clearTimeout(timer);this.pending.delete(id);socket.off('close',cancel);};
    const cancel=()=>{cleanup();};
    const timer=setTimeout(()=>{cleanup();reject();},10000);timer.unref();socket.once('close',cancel);
    this.pending.set(id,{connection:c,token,reject:()=>{cleanup();reject();},accept:ws=>{
      cleanup();if(socket.destroyed||this.connections.get(match[1]!)!==c){ws.terminate();return;}
      const stream=relayDuplex(ws);c.streams.add(stream);stream.on('error',()=>socket.destroy());socket.on('error',()=>stream.destroy());
      stream.once('close',()=>{c.streams.delete(stream);socket.destroy();ws.terminate();});socket.once('close',()=>stream.destroy());
      const headers=Object.entries(req.headers).filter(([k])=>!['authorization','cookie','host','origin'].includes(k)).map(([k,v])=>`${k}: ${Array.isArray(v)?v.join(','):v}`).join('\r\n');
      stream.write(`GET /rpc HTTP/1.1\r\nHost: personal-machine\r\n${headers}\r\n\r\n`);if(head.length)stream.write(head);stream.pipe(socket);socket.pipe(stream);
    }});
    c.socket.send(JSON.stringify({type:'open',id,token}));return true;
  }
  close(){return this.closeOperation??=(async()=>{this.closed=true;for(const response of this.downloads)response.destroy();for(const[id,c]of this.connections)this.retire(id,c);for(const p of this.pending.values())p.reject();this.sockets.close();await this.store.close();})();}
}
