import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, stat, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareBrowserRuntimeAccess} from '../../scripts/remote-browser-access.mjs';

test('private installation modes permit the browser UID without exposing adjacent state',{skip:process.platform==='win32'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'browser-installed-access-'));
 try{
  const assets=join(root,'runtime');await mkdir(assets,{mode:0o700});
  const executable=join(assets,'electron');await writeFile(executable,'fixture',{mode:0o700});
  const asset=join(assets,'worker.cjs');await writeFile(asset,'fixture',{mode:0o600});
  const state=join(root,'cookies');await writeFile(state,'private',{mode:0o600});
  await prepareBrowserRuntimeAccess(assets);
  assert.equal((await stat(assets)).mode&0o777,0o755);
  assert.equal((await stat(executable)).mode&0o777,0o755);
  assert.equal((await stat(asset)).mode&0o777,0o644);
  assert.equal((await stat(state)).mode&0o777,0o600);
  await symlink(state,join(assets,'state-link'));
  await assert.rejects(prepareBrowserRuntimeAccess(assets),/Unsupported browser runtime entry/);
  assert.equal((await stat(state)).mode&0o777,0o600);
 }finally{await rm(root,{recursive:true,force:true});}
});
