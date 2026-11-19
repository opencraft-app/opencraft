import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewConfiguration, readReviewToken } from '../plugins/support-review/src/config';
import { startReviewHandsOwner } from '../plugins/support-review/src/hands-owner';

test('review execution is opt-in and private per service; Gateway never consumes worker paths',async()=>{
 assert.equal(await reviewConfiguration('gateway',{}),null);assert.equal(await reviewConfiguration('hands',{}),null);
 const root=await mkdtemp(join(tmpdir(),'review-config-'));const file=join(root,'config.json');
 const env={OPENCRAFT_SUPPORT_REVIEW_CONFIG:file};
 const connection={version:1,socketPath:join(root,'r.sock'),tokenFile:join(root,'token')};
 try {
  await writeFile(file,JSON.stringify(connection),{mode:0o600});assert.deepEqual(await reviewConfiguration('gateway',env),connection);
  await assert.rejects(reviewConfiguration('hands',env),/Invalid support/);
  const hands={...connection,workerRoot:join(root,'worker'),pythonExecutable:'/usr/bin/python3',socketGid:process.getgid!()};
  await writeFile(file,JSON.stringify(hands));assert.deepEqual(await reviewConfiguration('hands',env),hands);
  await assert.rejects(reviewConfiguration('gateway',env),/Invalid support/);
  await chmod(file,0o644);await assert.rejects(reviewConfiguration('hands',env),/private/);
  await chmod(file,0o600);const link=join(root,'link');await symlink(file,link);
  await assert.rejects(reviewConfiguration('hands',{OPENCRAFT_SUPPORT_REVIEW_CONFIG:link}),/private/);
 } finally {await rm(root,{recursive:true,force:true});}
});
test('configuration rejects arbitrary modules, relative paths and invalid groups',async()=>{
 const root=await mkdtemp(join(tmpdir(),'review-config-invalid-'));const path=join(root,'config.json');
 const base={version:1,socketPath:join(root,'r.sock'),tokenFile:join(root,'token'),workerRoot:join(root,'worker'),pythonExecutable:'/usr/bin/python3'};
 try {
  for(const value of [{...base,module:'/arbitrary/plugin.js'},{...base,pythonExecutable:'python3'},{...base,workerRoot:'/'},{...base,socketGid:-1},{...base,socketGid:'990'},{...base,version:2}]) {
   await writeFile(path,JSON.stringify(value),{mode:0o600});await assert.rejects(reviewConfiguration('hands',{OPENCRAFT_SUPPORT_REVIEW_CONFIG:path}));
  }
  const token=join(root,'token');await writeFile(token,'short',{mode:0o600});await assert.rejects(readReviewToken(token));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Hands never changes permissions on an unsafe shared socket directory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'review-parent-'));const tokenFile=join(root,'token');await writeFile(tokenFile,'t'.repeat(64),{mode:0o600});
 try {
  await chmod(root,0o777);
  await assert.rejects(startReviewHandsOwner({socketPath:join(root,'r.sock'),tokenFile,workerRoot:root,pythonExecutable:'/usr/bin/python3'}),/socket directory/);
 }finally{await chmod(root,0o700);await rm(root,{recursive:true,force:true});}
});
test('a second plugin owner cannot unlink or replace the live owner socket',async()=>{
 const root=await mkdtemp(join(tmpdir(),'review-owner-exclusive-'));const tokenFile=join(root,'token');await writeFile(tokenFile,'t'.repeat(64),{mode:0o600});
 const config={socketPath:join(root,'r.sock'),tokenFile,workerRoot:root,pythonExecutable:'/usr/bin/python3'};
 const owner=await startReviewHandsOwner(config);
 try {await assert.rejects(startReviewHandsOwner(config),/already exists/);}
 finally{await owner.close();await owner.close();await rm(root,{recursive:true,force:true});}
});
