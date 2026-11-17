import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,randomBytes} from 'node:crypto';
import {createServer,request} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';

const root=resolve(import.meta.dirname,'../..');
test('installed companion starts its real Host from an unrelated working directory',{timeout:45000},async t=>{
 try{await access(join(root,'runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'));}catch{t.skip('Prepare the DSH runtime before this integration test');return;}
 const temporary=await mkdtemp(join(tmpdir(),'oc-machine-')),state=join(temporary,'state'),home=join(temporary,'home');
 await mkdir(state);await mkdir(home);await mkdir(join(temporary,'unrelated'));
 const server=createServer(),sockets=new WebSocketServer({noServer:true});
 const credential=randomBytes(32).toString('base64url');
 server.on('upgrade',(req,socket,head)=>{if(req.url!=='/__opencraft_relay/control'||req.headers.authorization!=='Bearer '+credential){socket.destroy();return;}sockets.handleUpgrade(req,socket,head,ws=>sockets.emit('connection',ws));});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
 await writeFile(join(state,'connection.json'),JSON.stringify({schemaVersion:1,id:randomUUID(),hubId:randomUUID(),credential,phase:'enrolled',origin:'http://127.0.0.1:'+(server.address() as any).port}),{mode:0o600});
 const env={...process.env,HOME:home};
 for(const key of ['OPENCRAFT_DSH_URL','OPENCRAFT_DSH_REPOSITORY','CODEX_HOME','CURSOR_CONFIG_DIR'])delete env[key];
 const child=spawn(process.execPath,['--import',join(root,'node_modules/tsx/dist/loader.mjs'),join(root,'scripts/personal-machine/daemon.ts'),'--state',state],{cwd:join(temporary,'unrelated'),env,stdio:['ignore','pipe','pipe']});
 const exit=once(child,'exit');let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await exit;}for(const ws of sockets.clients)ws.terminate();sockets.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rm(temporary,{recursive:true,force:true});});
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await Promise.race([once(sockets,'connection'),exit.then(()=>{throw new Error('Companion startup failed: '+output.replace(/(token=|Bearer )[A-Za-z0-9_-]+/g,'$1[redacted]'));}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Companion did not connect')),30000);})]);
 }finally{clearTimeout(timer);}
 const status=await new Promise<any>((done,fail)=>{const r=request({socketPath:join(state,'control.sock'),path:'/status'},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>done(JSON.parse(data)));});r.on('error',fail);r.end();});
 assert.equal(status.connected,true);
 assert.equal(typeof status.machine.machineId,'string');
 assert.equal(child.exitCode,null);
});
