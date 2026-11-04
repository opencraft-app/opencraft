import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createCodexMaintenanceClient } from '@opencraft/account-pool-host';

test('maintenance close waits for actual inherited stdio and writer release after a kill signal', async () => {
  const root=await mkdtemp(join(tmpdir(),'oc-maint-release-'));
  const script=join(root,'native.mjs');
  const content=`#!${process.execPath}
import {createInterface} from 'node:readline';
import {spawn} from 'node:child_process';
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{const value=JSON.parse(line);if(value.method==='initialize')console.log(JSON.stringify({id:value.id,result:{}}));});
lines.on('close',()=>{});
process.on('SIGTERM',()=>{spawn(process.execPath,['-e',\"setTimeout(()=>require('node:fs').writeFileSync(process.env.CODEX_HOME+'/writer-released','yes'),2500)\"],{stdio:'inherit'});});
setInterval(()=>{},1000);
`;
  await writeFile(script,content,{mode:0o700});
  const client=await createCodexMaintenanceClient({executable:script,codexHome:root});
  try {await client.close();assert.equal(await readFile(join(root,'writer-released'),'utf8'),'yes');}
  finally {await client.close();await rm(root,{recursive:true,force:true});}
});
