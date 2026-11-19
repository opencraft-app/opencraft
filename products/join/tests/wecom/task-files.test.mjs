import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {join} from 'node:path';
import {createTaskFiles} from '../../plugins/wecom/task-files.mjs';

test('exports include only bounded regular files, rejecting traversal, symlinks and hardlinks',t=>{
  const root=fs.mkdtempSync(join(os.tmpdir(),'task-files-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const files=createTaskFiles({root}),dir=files.prepare('scope:task');
  fs.writeFileSync(join(dir,'report.pdf'),'report');
  fs.writeFileSync(join(root,'private'),'secret');fs.symlinkSync(join(root,'private'),join(dir,'link'));fs.linkSync(join(root,'private'),join(dir,'hardlink'));
  assert.deepEqual(files.list('scope:task').files.map(x=>x.name),['report.pdf']);
  assert.throws(()=>files.read('scope:task','../private'));assert.throws(()=>files.read('scope:task','link'));
  assert.equal(files.read('scope:task','report.pdf').bytes.toString(),'report');
});

test('rejected exports do not consume the batch quota',t=>{
 const root=fs.mkdtempSync(join(os.tmpdir(),'task-budget-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const files=createTaskFiles({root}),dir=files.prepare('task');
 for(const [name,mb]of [['a',20],['b',20],['c',20],['d',19],['e',2],['f',1]]){const fd=fs.openSync(join(dir,name),'w');fs.ftruncateSync(fd,mb*1024*1024);fs.closeSync(fd);}
 const result=files.list('task');assert.deepEqual(result.files.map(f=>f.name),['a','b','c','d','f']);assert.deepEqual(result.skipped,['e']);
});
test('delivery snapshot survives export deletion and restart and rejects altered snapshots',t=>{
 const root=fs.mkdtempSync(join(os.tmpdir(),'task-snapshot-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let files=createTaskFiles({root,namespace:'scope'}),dir=files.prepare('task');fs.writeFileSync(join(dir,'report.pdf'),'original');
 const frozen=files.freeze('task');fs.rmSync(dir,{recursive:true});files=createTaskFiles({root,namespace:'scope'});
 assert.deepEqual(files.freeze('task'),frozen);assert.equal(files.readDelivery('task','report.pdf').bytes.toString(),'original');
 assert.throws(()=>files.readDelivery('task','../report.pdf'),/unavailable/u);
 const snapshotDir=join(root,'.deliveries',fs.readdirSync(join(root,'.deliveries'))[0]);fs.writeFileSync(join(snapshotDir,frozen.files[0].sha256+'.bin'),'modified');
 assert.throws(()=>files.readDelivery('task','report.pdf'),/snapshot changed/u);
});
