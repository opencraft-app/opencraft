import assert from 'node:assert/strict';
import test from 'node:test';
import {PersonalMachineDirectory} from '../../apps/workbench-web/src/runtime/personal-machine-directory';
import {normalizeHostConnectionProfile,groupWorkInMachines} from '@opencraft/workbench-runtime';

test('owner directory projects live machine presence independently of a cold browser connection',{timeout:12000},async t=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'location');
 Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'http://fixture.test/settings/machines'}});
 t.after(()=>previous?Object.defineProperty(globalThis,'location',previous):Reflect.deleteProperty(globalThis,'location'));
 let connected=true;const urls:string[]=[];
 t.mock.method(globalThis,'fetch',async (url:unknown)=>{urls.push(String(url));return Response.json({hubId:'hub',ownerActorId:'human:owner',enrollmentOrigin:'https://relay.example',machines:[{id:'11111111-2222-4333-8444-555555555555',name:'remote machine',machine:{machineId:'11111111-2222-4333-8444-666666666666',name:'remote machine',platform:'linux'},phase:'enrolled',expiresAt:null,connected}]});});
 const directory=new PersonalMachineDirectory();t.after(()=>directory.close());
 const changed=()=>new Promise<void>(done=>{const stop=directory.subscribe(()=>{stop();done();});});
 const first=changed();directory.start();await first;
 const online=directory.profiles()[0]!;
 assert.equal(online.machinePresence,'online');assert.equal(online.autoConnect,false);
 assert.equal(groupWorkInMachines(directory.profiles())[0]!.hosts[0]!.machinePresence,'online');
 assert.equal(normalizeHostConnectionProfile(online).machinePresence,undefined,'live observation is not restored from saved recipes');
 const next=changed();connected=false;await next;
 const offline=directory.profiles()[0]!;
 assert.equal(offline.machinePresence,'offline');assert.equal(offline.revision,online.revision,'presence must not replace the Host connection');
 assert.deepEqual(offline.providerConfig,online.providerConfig);assert.equal(offline.autoConnect,false);
 assert.ok(urls.every(url=>url==='/__opencraft_machines/status'),'passive observation never opens a machine RPC or starts an Agent');
});
