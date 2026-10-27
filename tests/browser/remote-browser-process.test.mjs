import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Run the real Node Writable failure in a separate Gateway process: the old
// service crashes the process despite passing a callback to stdin.write().
const serviceUrl = new URL('../../scripts/remote-browser-service.mjs', import.meta.url).href;
const probe = String.raw`
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteBrowserService } from '${serviceUrl}';
const directory = await mkdtemp(join(tmpdir(), 'browser-pipe-'));
await mkdir(join(directory,'runtime/browser/electron'),{recursive:true});
await writeFile(join(directory,'runtime/browser/worker.cjs'),'');
await writeFile(join(directory,'runtime/browser/electron/electron'),'');
const children=[];
let first=true;
const service = new RemoteBrowserService({root:directory,dataDirectory:directory,spawnImpl(_command,args,options){
 assert(args.some(x=>x.startsWith('--unit=')), 'exercise the isolated line-pipe transport');
 const broken=first;first=false;
 const child=spawn(process.execPath,['-e',broken
  ? "require('fs').closeSync(0);console.log(JSON.stringify({type:'ready'}));setInterval(()=>{},1000)"
  : "console.log(JSON.stringify({type:'ready'}));require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);console.log(JSON.stringify({type:'result',id:m.id,value:'replacement-ok'}))})"
 ],{env:options.env,stdio:['pipe','pipe','pipe']});children.push(child);return child;
}});
let closed=0;
try {
 await service.start();
 const old=service.child;
 old.stderr.emit('data',Buffer.from('[1:1:FATAL:ui/events/bitset_32.h:27] DCHECK failed: private-secret\n#0 0x123 ui::VelocityTracker::AddMovement()\n'));
 const viewer=()=>({close(code){assert.equal(code,1011);closed++}});const a=viewer(),b=viewer();
 const page={live:true,controller:a,viewers:new Map([[a,{}],[b,{}]])};service.pages.set('synthetic',page);
 await assert.rejects(service.request('page','capture'),error=>{
  assert.match(error.message,/disconnected|exited/);
  assert.equal(error.code,'BROWSER_UNAVAILABLE');assert.equal(error.retryable,true);return true;
 });
 await new Promise(r=>setTimeout(r,50));
 assert.equal(service.child,null);assert.equal(service.requests.size,0);assert.equal(page.live,false);assert.equal(closed,2);
 assert.equal(service.lastBrowserFailure.native.fatal.file,'bitset_32.h');
 assert.equal(service.lastBrowserFailure.native.frames[0].symbol,'ui::VelocityTracker::AddMovement');
 assert(!JSON.stringify(service.lastBrowserFailure).includes('private-secret'));
 await service.start();const replacement=service.child;
 assert.notEqual(old,replacement);
 old.emit('message',{type:'error',page:'page',message:'late'});
 old.stdin.emit('error',Object.assign(new Error('late'),{code:'EPIPE'}));
 old.stdout.emit('error',new Error('late read'));
 old.emit('error',new Error('late process'));
 old.emit('exit',1);
 assert.equal(service.child,replacement);assert.equal(closed,2);
 assert.equal(await service.request('page','capture'),'replacement-ok');
 service.close();replacement.stdin.emit('error',new Error('late close'));
 await new Promise(r=>setTimeout(r,20));
 console.log('gateway-survived-and-recovered');
} finally {
 service.pages.clear();service.close();for(const child of children)child.kill();
 await service.persistence;await rm(directory,{recursive:true,force:true});
}
`;
test('isolated browser EPIPE retires only its generation and Gateway survives/reconnects', {skip:process.getuid?.()!==0}, () => {
  const result=spawnSync(process.execPath,['--input-type=module','-e',probe],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr||result.error?.message);
  assert.match(result.stdout,/gateway-survived-and-recovered/);
  assert.doesNotMatch(result.stderr,/private-secret/);
});
