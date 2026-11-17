import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,access,symlink} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {WebSocketServer} from 'ws';
const root=resolve(import.meta.dirname,'../..');
test('complete installer reports success after connecting and installs usable local controls',{timeout:45000},async t=>{
 try{await access(join(root,'runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'));}catch{t.skip('Prepare DSH before installer integration');return;}
 const directory=await mkdtemp(join(tmpdir(),'oc-install-')),state=join(directory,'machine'),home=join(directory,'home');await mkdir(state);await mkdir(home);await symlink(root,join(state,'runtime'));
 const credential=randomBytes(32).toString('base64url'),server=createServer(),sockets=new WebSocketServer({noServer:true});
 server.on('upgrade',(req,socket,head)=>{if(req.headers.authorization!=='Bearer '+credential){socket.destroy();return;}sockets.handleUpgrade(req,socket,head,ws=>sockets.emit('connection',ws));});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
 await writeFile(join(state,'connection.json'),JSON.stringify({schemaVersion:1,id:randomUUID(),hubId:randomUUID(),credential,phase:'enrolled',origin:'http://127.0.0.1:'+(server.address() as any).port}),{mode:0o600});
 const env={...process.env,HOME:home,PATH:dirname(process.execPath)+':'+process.env.PATH,DBUS_SESSION_BUS_ADDRESS:'unix:path='+join(directory,'no-user-bus'),XDG_RUNTIME_DIR:directory};
 for(const key of ['OPENCRAFT_DSH_URL','OPENCRAFT_DSH_REPOSITORY','CODEX_HOME','CURSOR_CONFIG_DIR'])delete env[key];
 const command=(args:string[])=>new Promise<string>((done,fail)=>{const child=spawn(process.execPath,args,{cwd:home,env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);child.on('error',fail);child.on('exit',code=>code===0?done(output):fail(new Error(output.replace(/(token=|Bearer )[A-Za-z0-9_-]+/g,'$1[redacted]'))));});
 t.after(async()=>{try{await command([join(state,'launcher.mjs'),'--state',state,'--stop']);}catch{}for(const ws of sockets.clients)ws.terminate();sockets.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rm(directory,{recursive:true,force:true});});
 const output=await command(['--import',join(root,'node_modules/tsx/dist/loader.mjs'),join(root,'scripts/personal-machine/daemon.ts'),'--state',state,'--install']);
 assert.match(output,/OpenCraft machine connected/);assert.match(output,/Local controls:.*opencraft-machine/);
 const status=JSON.parse(await command([join(state,'launcher.mjs'),'--state',state,'--status']));assert.equal(status.connected,true);
});
