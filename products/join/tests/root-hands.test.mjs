import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { rootHandsConfiguration, prepareRootHands, prepareRootWorkspace, synchronizeRootHands } from '../root-hands.mjs';
const environment = {
  OPENCRAFT_ROOT_HANDS_SERVER_DIRECTORY: '/ipc/server', OPENCRAFT_ROOT_HANDS_CLIENT_DIRECTORY: '/ipc/client',
  OPENCRAFT_HANDS_CLIENT_DIRECTORY: '/public', OPENCRAFT_EXECUTION_DIR: '/ipc/server',
  OPENCRAFT_HANDS_CLIENT_UID: '994', OPENCRAFT_HANDS_CLIENT_GID: '990',
};
test('root Hands requires explicit portable paths and a nonroot browser/client identity', () => {
  assert.deepEqual(rootHandsConfiguration(environment), {server:'/ipc/server',client:'/ipc/client',publicClient:'/public',browserName:'browser',uid:994,gid:990});
  for (const changed of [{}, {...environment, OPENCRAFT_HANDS_CLIENT_UID:'0'}, {...environment, OPENCRAFT_HANDS_CLIENT_GID:'root'},
    {...environment, OPENCRAFT_ROOT_HANDS_CLIENT_DIRECTORY:'/ipc/server/child'},
    {...environment, OPENCRAFT_ROOT_HANDS_SERVER_DIRECTORY:'/ipc/../server'},
    {...environment, OPENCRAFT_EXECUTION_DIR:'/other'},
    ...['/','relative','/ipc/server','/ipc/server/browser'].map(value=>({...environment,OPENCRAFT_HANDS_BROWSER_DIRECTORY:value})),
    ...['..','/tmp/profile','nested/profile','other'].map(value=>({...environment,OPENCRAFT_HANDS_BROWSER_NAME:value}))]) assert.throws(() => rootHandsConfiguration(changed));
});


async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'root-hands-test-'));
  const c = {server:join(root,'server'),client:join(root,'client'),publicClient:join(root,'client'),uid:994,gid:990};
  for (const [path,uid,gid] of [[c.server,0,0],[c.client,c.uid,c.gid]]) {fs.mkdirSync(path,{mode:0o700});fs.chownSync(path,uid,gid);}
  t.after(() => rm(root,{recursive:true,force:true}));return c;
}
const rootOnly = {skip:process.getuid()!==0};
test('root/client token copies retain independent ownership and survive restart without rotation', rootOnly, async t => {
  const c=await fixture(t);prepareRootHands(c);
  const before=[];
  for(const name of ['files.token','terminal.token','exec-owner.token']) {
    const a=join(c.server,name),b=join(c.client,name);before.push(fs.readFileSync(a,'utf8'));
    assert.equal(fs.readFileSync(a,'utf8'),fs.readFileSync(b,'utf8'));
    assert.equal(fs.statSync(a).uid,0);assert.equal(fs.statSync(b).uid,994);
    assert.equal(fs.statSync(a).mode&0o777,0o600);assert.equal(fs.statSync(b).mode&0o777,0o600);
  }
  prepareRootHands(c);
  assert.deepEqual(['files.token','terminal.token','exec-owner.token'].map(name=>fs.readFileSync(join(c.server,name),'utf8')),before);
  assert.equal(fs.statSync(join(c.client,'browser')).uid,994);
});
test('credential mismatch, symlink, wrong alias and open directories fail without repairing user data', rootOnly, async t => {
  const c=await fixture(t);prepareRootHands(c);
  const path=join(c.client,'files.token'),before=fs.readFileSync(join(c.server,'files.token'));
  fs.writeFileSync(path,'a'.repeat(64)+'\n');assert.throws(()=>prepareRootHands(c),/disagree/);
  assert.deepEqual(fs.readFileSync(join(c.server,'files.token')),before);
  fs.unlinkSync(path);fs.symlinkSync(join(c.server,'files.token'),path);assert.throws(()=>prepareRootHands(c));
  fs.unlinkSync(path);prepareRootHands(c);
  assert.throws(()=>prepareRootHands({...c,publicClient:c.server}));
  fs.chmodSync(c.client,0o755);assert.throws(()=>prepareRootHands(c),/private/);assert.equal(fs.statSync(c.client).mode&0o777,0o755);
});
test('authenticated root sockets publish through private clients and browser publishes in reverse', rootOnly, async t => {
  const c=await fixture(t);prepareRootHands(c);
  const listen=async(path,uid)=>{const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve)});fs.chownSync(path,uid,uid===0?0:990);t.after(()=>new Promise(resolve=>server.close(resolve)));};
  await listen(join(c.server,'files.sock'),0);await listen(join(c.client,'browser/owner.sock'),994);
  synchronizeRootHands(c);
  assert.equal(fs.statSync(join(c.server,'files.sock')).ino,fs.statSync(join(c.client,'files.sock')).ino);
  assert.equal(fs.statSync(join(c.client,'files.sock')).mode&0o777,0o666);
  assert.equal(fs.statSync(c.client).mode&0o777,0o700);
  assert.equal(fs.statSync(join(c.server,'browser/owner.sock')).uid,994);
  synchronizeRootHands(c);
  fs.unlinkSync(join(c.client,'files.sock'));fs.writeFileSync(join(c.client,'files.sock'),'do-not-replace');
  assert.throws(()=>synchronizeRootHands(c),/non-socket/);
  assert.equal(fs.readFileSync(join(c.client,'files.sock'),'utf8'),'do-not-replace');
});

test('new projectless directories belong to clients; retained directories are never re-owned', rootOnly, async t => {
 const c=await fixture(t);const workspace=join(c.client,'workspace');fs.mkdirSync(workspace,{mode:0o700});fs.chownSync(workspace,994,990);
 prepareRootWorkspace(c,{OPENCRAFT_WORKSPACE_DIR:workspace});
 for(const name of ['sessions','sessions/codex','sessions/dsh'])assert.equal(fs.statSync(join(workspace,name)).uid,994);
 const legacy=join(workspace,'legacy');fs.mkdirSync(legacy,{mode:0o700});
 prepareRootWorkspace(c,{OPENCRAFT_WORKSPACE_DIR:workspace,OPENCRAFT_CODEX_PROJECTLESS_DIR:legacy});
 assert.equal(fs.statSync(legacy).uid,0);assert.equal(fs.statSync(legacy).mode&0o777,0o700);
});

test('explicit legacy browser root retains the existing private profile without moving or reowning it', rootOnly, async t => {
  const c = {...await fixture(t), browserName:'.'};
  fs.writeFileSync(join(c.client,'Preferences'), 'retained-profile', {mode:0o600});
  fs.chownSync(join(c.client,'Preferences'),c.uid,c.gid);
  prepareRootHands(c);
  assert.equal(fs.readFileSync(join(c.client,'Preferences'),'utf8'),'retained-profile');
  assert.equal(fs.existsSync(join(c.client,'browser')),false);
  const endpoint=join(c.client,'owner.sock'), owner=createServer();
  await new Promise(resolve=>owner.listen(endpoint,resolve));t.after(()=>new Promise(resolve=>owner.close(resolve)));
  fs.chownSync(endpoint,c.uid,c.gid);synchronizeRootHands(c);
  assert.equal(fs.statSync(endpoint).ino,fs.statSync(join(c.server,'browser/owner.sock')).ino);
  assert.equal(fs.statSync(c.client).uid,c.uid);assert.equal(fs.statSync(c.client).mode&0o777,0o700);
});

test('retained browser profile can own the common filesystem root while IPC roots remain separate', rootOnly, async t=>{
 const c=await fixture(t), profile=join(c.server,'..');
 const browserDirectory=fs.realpathSync(profile);fs.chownSync(browserDirectory,994,990);
 const configured={...c,browserDirectory};
 fs.writeFileSync(join(browserDirectory,'Preferences'),'retained',{mode:0o600});fs.chownSync(join(browserDirectory,'Preferences'),994,990);
 prepareRootHands(configured);assert.equal(fs.readFileSync(join(browserDirectory,'Preferences'),'utf8'),'retained');
 assert.equal(fs.existsSync(join(c.client,'browser')),false);
 const endpoint=join(browserDirectory,'owner.sock'),owner=createServer();await new Promise(r=>owner.listen(endpoint,r));
 t.after(()=>new Promise(r=>owner.close(r)));fs.chownSync(endpoint,994,990);synchronizeRootHands(configured);
 assert.equal(fs.statSync(endpoint).ino,fs.statSync(join(c.server,'browser/owner.sock')).ino);
 assert.equal(fs.statSync(c.server).uid,0);assert.equal(fs.statSync(c.client).uid,994);
 assert.throws(()=>prepareRootHands({...c,browserDirectory:join(browserDirectory,'missing')}));
 assert.equal(fs.existsSync(join(browserDirectory,'missing')),false);
});
