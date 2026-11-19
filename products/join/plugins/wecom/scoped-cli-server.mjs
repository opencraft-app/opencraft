import {errorCategory,logOperation} from './operation-diagnostics.mjs';
import fs from 'node:fs';
import {createServer,createConnection} from 'node:net';
import {join} from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {durableJson,durableBytes,readJson} from './durable-json.mjs';
import {scopedWecomCli} from '../../tools/wecom-cli/scoped.mjs';
/** Private, revocable group-bound port, reusing the authenticated assistant's
 * request path. Only a launcher path goes into delegated tasks, never credentials. */
export async function openScopedWecomCli({directory,socketDirectory,scope,request,signal}) {
  if(!/^[a-f0-9]{64}$/u.test(scope))throw Error('Invalid CLI scope');
  for(const d of [directory,socketDirectory]){fs.mkdirSync(d,{recursive:true,mode:0o700});const s=fs.lstatSync(d);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||s.mode&0o077)throw Error('Unsafe CLI directory');}
  const socketPath=join(socketDirectory,'wc-'+scope.slice(0,24)+'.sock');if(Buffer.byteLength(socketPath)>100)throw Error('CLI socket path too long');
  const prior=fs.lstatSync(socketPath,{throwIfNoEntry:false});
  if(prior){if(!prior.isSocket()||prior.uid!==process.getuid())throw Error('Unsafe CLI socket');await new Promise((resolve,reject)=>{const probe=createConnection(socketPath);probe.setTimeout(1000,()=>{probe.destroy();reject(Error('CLI socket busy'));});probe.once('connect',()=>{probe.destroy();reject(Error('CLI scope already active'));});probe.once('error',e=>{probe.destroy();if(e.code==='ECONNREFUSED'){fs.unlinkSync(socketPath);resolve();}else reject(e);});});}
  const token=randomBytes(32).toString('base64url'),clients=new Set(),pending=new Set();let closed=false,closing;
  const server=createServer(socket=>{
    if(clients.size>=16){socket.destroy();return;}
    socket.setEncoding('utf8');clients.add(socket);socket.once('close',()=>clients.delete(socket));socket.setTimeout(30000,()=>socket.destroy());
    let buffer='',received=false;
    const fail=(error,correlationId)=>{if(!socket.destroyed)socket.end(JSON.stringify({error,...(correlationId?{correlationId}:{})})+'\n');};
    socket.on('error',()=>{});
    socket.on('data',chunk=>{
      if(received)return;buffer+=chunk;
      if(Buffer.byteLength(buffer)>65536){received=true;fail('wecom_cli_request_too_large');return;}
      if(!buffer.includes('\n'))return;received=true;
      let body;try{body=JSON.parse(buffer.slice(0,buffer.indexOf('\n')));}catch{fail('invalid_wecom_cli_request');return;}
      if(closed||signal?.aborted||!body||Object.keys(body).some(k=>!['token','argv'].includes(k))||typeof body.token!=='string'||body.token.length!==token.length||Buffer.byteLength(body.token)!==Buffer.byteLength(token)||!timingSafeEqual(Buffer.from(body.token),Buffer.from(token))){fail('wecom_cli_denied');return;}
      if(pending.size>=8){fail('wecom_cli_busy');return;}
      const started=Date.now();
      const job=Promise.resolve().then(()=>request(body.argv)).then(result=>{if(closed||signal?.aborted)return fail('wecom_cli_denied');const response=JSON.stringify({result});if(Buffer.byteLength(response)>4*1024*1024)return fail('wecom_cli_response_too_large');socket.end(response+'\n');}).catch(error=>{const code=[error?.code,error?.message].find(value=>typeof value==='string'&&/^(?:wecom_[a-z_]{1,80}|idempotency_conflict)$/u.test(value));if(code)return fail(code);const correlationId=randomBytes(16).toString('hex');logOperation({correlationId,stage:'cli',action:Array.isArray(body.argv)&&['rename','add','remove','get','live','status','request','verify'].includes(body.argv[1])?body.argv[1]:'request',category:errorCategory(error),elapsedMs:Date.now()-started});fail('wecom_cli_failed',correlationId);}).finally(()=>pending.delete(job));pending.add(job);
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});fs.chmodSync(socketPath,0o600);const inode=fs.statSync(socketPath).ino;
  const connection=join(directory,'binding.json'),launcher=join(directory,'wecom');
  const close=()=>closing??=(async()=>{
    closed=true;signal?.removeEventListener('abort',abort);
    for(const client of clients)client.destroy();await new Promise(resolve=>server.close(resolve));await Promise.allSettled([...pending]);
    if(fs.lstatSync(socketPath,{throwIfNoEntry:false})?.ino===inode)fs.unlinkSync(socketPath);
    if(readJson(connection)?.token===token)fs.rmSync(connection,{force:true});
  })();
  const abort=()=>{void close();};signal?.addEventListener('abort',abort,{once:true});
  try{signal?.throwIfAborted();durableJson(connection,{socket:socketPath,token});durableBytes(launcher,Buffer.from('#!'+process.execPath+'\n('+scopedWecomCli.toString()+')(process.argv.slice(2),'+JSON.stringify(connection)+').catch(error=>{process.stderr.write(JSON.stringify({error:String(error.message).slice(0,300),correlationId:error.correlationId})+"\\n");process.exitCode=1;});\n'));fs.chmodSync(launcher,0o700);return {launcher,close};}
  catch(error){await close();throw error;}
}
