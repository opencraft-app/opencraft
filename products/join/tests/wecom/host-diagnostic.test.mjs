import '../../plugins/wecom/assistant-install.mjs';
import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import os from'node:os';import{join}from'node:path';
import {spawnAssistant}from'../../../../apps/personal-assistant/src/runtime/host-supervisor.mjs';
test('failed child initialization records a bounded private diagnostic without publishing chat content',async t=>{
 const directory=fs.mkdtempSync(join(os.tmpdir(),'assistant-startup-')),oldData=process.env.OPENCRAFT_DATA_DIR,oldWs=process.env.OPENCRAFT_WORKSPACE_DIR;process.env.OPENCRAFT_DATA_DIR=directory;process.env.OPENCRAFT_WORKSPACE_DIR=directory+'-ws';
 const handle=spawnAssistant({directory,profileOptions:{mode:'fixture'},request:async()=>{throw Error('fixture_authority_denied');}});
 t.after(async()=>{await handle.close();fs.rmSync(directory,{recursive:true,force:true});if(oldData===undefined)delete process.env.OPENCRAFT_DATA_DIR;else process.env.OPENCRAFT_DATA_DIR=oldData;if(oldWs===undefined)delete process.env.OPENCRAFT_WORKSPACE_DIR;else process.env.OPENCRAFT_WORKSPACE_DIR=oldWs;});
 await assert.rejects(handle.ready);await handle.close();const file=join(directory,'join-wecom-host-failures.log');assert.equal(fs.statSync(file).mode&0o077,0);const record=JSON.parse(fs.readFileSync(file,'utf8').trim().split('\n')[0]);assert.match(record.error,/fixture_authority_denied/u);assert.ok(record.error.length<=200);
});

test('host provisioning failure before child spawn records a private diagnostic',async t=>{
 const directory=fs.mkdtempSync(join(os.tmpdir(),'assistant-host-')),oldData=process.env.OPENCRAFT_DATA_DIR,oldWs=process.env.OPENCRAFT_WORKSPACE_DIR;process.env.OPENCRAFT_DATA_DIR=directory;process.env.OPENCRAFT_WORKSPACE_DIR=directory+'-ws';
 const {createPersonalAssistantHost}=await import('../../../../apps/personal-assistant/src/runtime/host-supervisor.mjs');
 const host=await createPersonalAssistantHost({directory,intervalMs:10,readConfig:async()=>({maxRuntimes:1,profileOptions:{mode:'fixture'}}),spawn(){assert.fail('provision failed: must not spawn');},service:{attachPersonalAssistantHost(){return()=>{};},personalAssistantAssignments:async()=>({items:[{epoch:1,context:{},assistant:{binding:{botId:'fixture-bot'}}}]}),provisionPersonalAssistant:async()=>{throw Error('fixture_provision_denied');}}});
 t.after(async()=>{await host.close();fs.rmSync(directory,{recursive:true,force:true});if(oldData===undefined)delete process.env.OPENCRAFT_DATA_DIR;else process.env.OPENCRAFT_DATA_DIR=oldData;if(oldWs===undefined)delete process.env.OPENCRAFT_WORKSPACE_DIR;else process.env.OPENCRAFT_WORKSPACE_DIR=oldWs;});
 const file=join(directory,'join-wecom-host-failures.log');for(let i=0;i<200&&!fs.existsSync(file);i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(fs.statSync(file).mode&0o077,0);assert.match(fs.readFileSync(file,'utf8'),/fixture_provision_denied/u);assert.equal(host.state('fixture-bot').phase,'retrying');
});
