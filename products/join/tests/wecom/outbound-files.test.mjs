import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { MAX_GROUP_FILE_BYTES, GROUP_FILE_CHUNK_BYTES, stageGroupFileChunk, stageGroupFile, stagedGroupFile } from '../../plugins/wecom/outbound-files.mjs';
import { LocalAttachmentStore } from '../../../../apps/personal-assistant/src/adapters/filesystem/attachment-store.mjs';
import { LocalRunner } from '../../../../apps/personal-assistant/src/runtime/local-runner.mjs';
import { provisionBotProfile } from '../../../../apps/personal-assistant/src/adapters/local/bot-profile.mjs';
test('20 MiB crosses bounded IPC chunks, supports exact retry, rejects mutation and overflow',t=>{
  const directory=fs.mkdtempSync(join(os.tmpdir(),'wecom-out-'));
  process.env.OPENCRAFT_DATA_DIR=directory;process.env.OPENCRAFT_WORKSPACE_DIR=directory+'-ws';
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const bytes=Buffer.alloc(MAX_GROUP_FILE_BYTES,7);let complete;
  for(let offset=0;offset<bytes.length;offset+=GROUP_FILE_CHUNK_BYTES){
    const chunk=bytes.subarray(offset,offset+GROUP_FILE_CHUNK_BYTES);
    assert.ok(JSON.stringify({data:chunk.toString('base64')}).length<1024*1024);
    complete=stageGroupFileChunk('upload','report.pdf',chunk,offset,bytes.length);
  }
  assert.deepEqual(complete,bytes);
  assert.equal(stageGroupFileChunk('upload','report.pdf',bytes.subarray(0,GROUP_FILE_CHUNK_BYTES),0,bytes.length),null);
  assert.throws(()=>stageGroupFileChunk('upload','report.pdf',Buffer.from('changed'),0,bytes.length));
  assert.throws(()=>stageGroupFileChunk('overflow','report.pdf',Buffer.from('x'),0,MAX_GROUP_FILE_BYTES+1));
  stageGroupFile('message','report.pdf',complete);assert.equal(stagedGroupFile('message').bytes.length,MAX_GROUP_FILE_BYTES);
});
test('the group runner imports, describes and materializes 20 MiB; ordinary stores retain 8 MiB',async t=>{
  const directory=fs.mkdtempSync(join(os.tmpdir(),'wecom-attachment-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const bytes=Buffer.alloc(MAX_GROUP_FILE_BYTES,9),file=join(directory,'large.pdf');fs.writeFileSync(file,bytes);
  const store=new LocalAttachmentStore(join(directory,'store'),{maxBytes:MAX_GROUP_FILE_BYTES});
  const item=store.importFile(file);assert.equal(store.describe(item.attachmentId).size,MAX_GROUP_FILE_BYTES);
  assert.equal(store.importFile(file).attachmentId,item.attachmentId,'same large bytes can be reimported');
  assert.deepEqual(store.read(item.attachmentId).bytes,bytes);
  assert.equal(store.materialize(item.attachmentId,join(directory,'assets')).size,MAX_GROUP_FILE_BYTES);
  assert.throws(()=>new LocalAttachmentStore(join(directory,'ordinary')).importFile(file),/bounded/);
  assert.throws(()=>new LocalAttachmentStore(join(directory,'too-large'),{maxBytes:MAX_GROUP_FILE_BYTES+1}));
  const profile=provisionBotProfile(join(directory,'profile'),{serverId:'s',botId:'b',assignmentId:'a',owner:{kind:'human',id:'h'}},{telemetry:{enabled:false}});
  const runner=await LocalRunner.open(profile,{attachmentMaxBytes:MAX_GROUP_FILE_BYTES,localSocket:false,
    platformChannelPort:{authorize:async()=>({binding:profile.config.botBinding,epoch:'e',expiresAt:Date.now()+60000}),request:async()=>({})}});
  try {assert.equal(runner.attachmentStore.importFile(file).size,MAX_GROUP_FILE_BYTES);}finally{await runner.close();}
});

test('20MiB remains sendable with small CLI frames, not truncated by the old 256-chunk count',t=>{
 const folder=fs.mkdtempSync(join(os.tmpdir(),'wecom-cli-chunks-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));const old=process.env.OPENCRAFT_DATA_DIR;process.env.OPENCRAFT_DATA_DIR=folder;t.after(()=>{if(old===undefined)delete process.env.OPENCRAFT_DATA_DIR;else process.env.OPENCRAFT_DATA_DIR=old;});
 const bytes=Buffer.alloc(20*1024*1024,65);let complete;for(let offset=0;offset<bytes.length;offset+=40*1024)complete=stageGroupFileChunk('cli-full','full.pdf',bytes.subarray(offset,offset+40*1024),offset,bytes.length);assert.deepEqual(complete,bytes);
});

test('upload mode is frozen across chunks and successful-delivery receipts',async t=>{
 const {finishGroupFileUpload}=await import('../../plugins/wecom/outbound-files.mjs');const dir=fs.mkdtempSync(join(os.tmpdir(),'wecom-modes-')),old=process.env.OPENCRAFT_DATA_DIR;process.env.OPENCRAFT_DATA_DIR=dir;t.after(()=>{if(old===undefined)delete process.env.OPENCRAFT_DATA_DIR;else process.env.OPENCRAFT_DATA_DIR=old;fs.rmSync(dir,{recursive:true,force:true});});
 const bytes=Buffer.from('original');assert.deepEqual(stageGroupFileChunk('mode','photo.png',bytes,0,bytes.length,'file'),bytes);assert.throws(()=>stageGroupFileChunk('mode','photo.png',bytes,0,bytes.length,'image'),/changed/);
 finishGroupFileUpload('mode','message');assert.equal(stageGroupFileChunk('mode','photo.png',bytes,0,bytes.length,'file').deliveredMessageId,'message');assert.throws(()=>stageGroupFileChunk('mode','photo.png',bytes,0,bytes.length,'auto'),/changed/);
});
