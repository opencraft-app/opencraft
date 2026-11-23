import test from 'node:test';import assert from 'node:assert/strict';
import type { SandboxProcess, SandboxOutput } from '@opencraft/sandbox';
import { connectSandboxBrowserOwner } from '../../apps/local-agent-host/src/sandbox-browser-owner';
const greeting = { type: 'attached', protocol: 1, pages: [{ id: 'existing-tab' }], workerPid: 123, automationCancellation: 1, automationNavigation: 1 };
function fixture() {
 let emit!: (output: SandboxOutput) => void, exit!: (value: { code: number }) => void;
 let terminated = 0, lost = 0, cleanup = 0, revoked = false;
 const writes: string[] = [];
 const child: SandboxProcess = { id: 'proxy', kind: 'process', exited: new Promise(r => exit = r), async writeStdin(data) {
  const line = Buffer.from(data).toString(); writes.push(line);
  if (JSON.parse(line).type === 'attach') emit({ stream: 'stdout', data: Buffer.from(JSON.stringify(greeting)+'\n') });
 }, async closeStdin() {}, async terminate() { terminated++; exit({ code: 0 }); } };
 const options = { socketPath: '/tmp/opencraft-browser-test/owner.sock', authorize: async () => { if (revoked) throw Error('revoked'); },
  onLost() { lost++; }, onCleanupUnconfirmed() { cleanup++; }, sandbox: { async spawn(command: any, output: any) {
   assert.deepEqual(command.command.slice(0,4), ['/usr/bin/python3','-I','-u','-c']);assert.equal(command.attached, true);assert.equal(command.cwd, '/workspace');assert.deepEqual(command.env, {});
   emit = output; return child;
  } } };
 return { options, child, writes, emit(data: Buffer) { emit({ stream: 'stdout', data }); }, exit, revoke() { revoked = true; }, get terminated() { return terminated; }, get lost() { return lost; }, get cleanup() { return cleanup; } };
}
test('private attach adopts actual inventory and handles split Unicode owner messages', async () => {
 const f=fixture(), transport=await connectSandboxBrowserOwner(f.options);
 assert.deepEqual(transport.inventory,greeting.pages);assert.equal(transport.workerPid,123);
 const messages:unknown[]=[];transport.on('message',m=>messages.push(m));
 const line=Buffer.from(JSON.stringify({type:'result',id:'one',value:'资料'})+'\n');
 for(const byte of line)f.emit(Buffer.from([byte]));await new Promise(r=>setImmediate(r));
 assert.deepEqual(messages,[{type:'result',id:'one',value:'资料'}]);
 await new Promise<void>((resolve,reject)=>transport.send({id:'one',method:'inventory'},error=>error?reject(error):resolve()));
 assert.equal(f.writes.length,2);await transport.close();assert.equal(f.terminated,1);assert.equal(f.lost,0);
});
test('remote proxy exit notifies loss once; intentional detach never kills another process',async()=>{
 const f=fixture(),transport=await connectSandboxBrowserOwner(f.options);const ended=new Promise<void>(r=>transport.on('exit',()=>r()));
 f.exit({code:1});await ended;await transport.close();assert.equal(f.lost,1);assert.equal(f.terminated,1);assert.equal(transport.connected,false);
});
test('authority revocation prevents writes and retires the private attachment',async()=>{
 const f=fixture(),transport=await connectSandboxBrowserOwner(f.options);f.revoke();
 await new Promise<void>(resolve=>transport.send({id:'one',method:'input'},error=>{assert.ok(error);resolve()}));
 await transport.close();assert.equal(f.writes.length,1);assert.equal(f.lost,1);
});
test('invalid socket paths never spawn and malformed owner output retires the connection',async()=>{
 const f=fixture();await assert.rejects(connectSandboxBrowserOwner({...f.options,socketPath:'/tmp/other.sock'}),/Invalid/);
 const transport=await connectSandboxBrowserOwner(f.options);const ended=new Promise<void>(r=>transport.on('exit',()=>r()));f.emit(Buffer.from('not-json\n'));await ended;await transport.close();assert.equal(f.lost,1);
});
test('old/incompatible owners are rejected without inventing capability support',async()=>{
 const f=fixture();f.child.writeStdin=async()=>f.emit(Buffer.from(JSON.stringify({...greeting,automationNavigation:0})+'\n'));
 await assert.rejects(connectSandboxBrowserOwner(f.options),/unavailable/);assert.equal(f.terminated,1);assert.equal(f.lost,0);
});
test('revocation during attach cannot expose a ready connection',async()=>{
 const f=fixture(),send=f.child.writeStdin;f.child.writeStdin=async data=>{f.revoke();await send(data)};
 await assert.rejects(connectSandboxBrowserOwner(f.options),/revoked/);assert.equal(f.terminated,1);
});
test('unconfirmed proxy cleanup is surfaced to its lifecycle owner',async()=>{
 const f=fixture(),transport=await connectSandboxBrowserOwner(f.options);f.child.terminate=async()=>{throw Error('failed')};
 await assert.rejects(transport.close(),/cleanup unconfirmed/);assert.equal(f.cleanup,1);
});
test('oversized or invalid outgoing frames never reach the private owner',async()=>{
 const f=fixture(),transport=await connectSandboxBrowserOwner(f.options);
 for(const message of [undefined,{id:'x'.repeat(101)}, {id:'big',input:'x'.repeat(256*1024)}])
  await new Promise<void>(resolve=>transport.send(message,error=>{assert.ok(error);resolve()}));
 assert.equal(f.writes.length,1);assert.equal(transport.connected,true);await transport.close();
});
test('invalid UTF8 input cannot corrupt subsequent owner messages',async()=>{
 const f=fixture(),transport=await connectSandboxBrowserOwner(f.options),ended=new Promise<void>(r=>transport.on('exit',()=>r()));
 f.emit(Buffer.from([0xff,10]));await ended;await transport.close();assert.equal(f.lost,1);
});
