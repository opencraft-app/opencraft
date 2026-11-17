import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {machineServiceUnit} from '../../scripts/personal-machine/service.mjs';
import {stop} from '../../scripts/personal-machine/update.mjs';
test('systemd path directives and command arguments have distinct escaping',()=>{
 const unit=machineServiceUnit('/data/home/user name%/machine','/usr/bin/node');
 assert(unit.includes('WorkingDirectory=/data/home/user name%%/machine/runtime\n'));
 assert(unit.includes('ExecStart="/usr/bin/node" "/data/home/user name%%/machine/launcher.mjs"'));
 assert(!unit.includes('WorkingDirectory="'));
 assert.throws(()=>machineServiceUnit('/data/evil\nExecStart=/bin/sh','/usr/bin/node'));
});
test('a rejected inactive service does not block rollback with another failing stop',async t=>{
 const state=await mkdtemp(join(tmpdir(),'oc-service-'));t.after(()=>rm(state,{recursive:true,force:true}));const unit=join(state,'machine.service');await writeFile(unit,'bad unit');await writeFile(join(state,'connection.json'),JSON.stringify({id:randomUUID()}));let stopped=false;
 await stop(state,unit,{capture:async()=> 'LoadState=bad-setting\nActiveState=inactive\n',run:async()=>{stopped=true;throw new Error('stop must not run')}});assert.equal(stopped,false);
 await assert.rejects(stop(state,unit,{capture:async()=>'',run:async()=>{throw new Error('must not run')}}),/state is unknown/);
});
