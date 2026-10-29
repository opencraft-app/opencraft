import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile, mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c } from 'tar';
import { parseStrictJson, parseManifest, fileListDigest, sha256, signBytes, acceptManifest,
  signPreflight, verifyPreflight, HARD_LIMITS, LEGACY_LIMITS } from '../../scripts/full-release/contract.mjs';
import { acceptReleasePolicy } from '../../scripts/full-upgrade/release-policy.mjs';
import { sealPackage, npmPack, stagedInventory, archivePreparedPackage } from '../../scripts/full-release/producer.mjs';
import { copyPreparedTree } from '../../scripts/full-release/prepared-tree.mjs';
import { scanArchive as verifyInventoryArchive, verifyFullArchive, readReplayState, writeReplayState } from '../../scripts/full-release/archive.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keyId = 'test-key';
const trust = { product: 'test', channel: 'test', registry: 'https://registry.example/', packageName: '@example/app', keys: { [keyId]: publicKey.export({type:'spki',format:'pem'}) } };
const source = 'a'.repeat(40), now = Date.now();
function fixture() {
  const files = [['LICENSE',sha256('license'),7,'0644']];
  return { schemaVersion:1, kind:'opencraft.full-release', release:{releaseId:'test-release',releaseSequence:1,createdAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+86400000).toISOString(),product:'test',channel:'test',source:{revision:source,upstreamRevision:source,patchSetSha256:'a'.repeat(64)}},
    transport:{kind:'npm',registry:trust.registry,packageName:trust.packageName,exactVersion:'1.0.0'},
    targets:[{profile:'headless',platform:process.platform,arch:process.arch,nodeAbi:Number(process.versions.modules)}],
    updater:{minBootstrap:1,minAgent:1,helperProtocol:1,bridge:true,legacy:{...LEGACY_LIMITS}},
    revocations:{sequence:1,keyIds:[],releaseIds:[]},
    components:[{componentId:'runtime',role:'web-bootstrap',version:'1.0.0',buildId:'fixture',sourceRevision:source,required:true,enabledPolicy:'preserve',content:{kind:'tree',root:'.',fileListSha256:fileListDigest(files),unpackedBytes:7,entries:1},fileList:files,provides:[],requires:[],activation:{strategy:'helper',unitRole:'bootstrap',authority:'unsupported',retainedHistory:true},licenses:['LICENSE']}],
    stores:[],rollback:{policy:'compatible-retained-only',automaticSnapshotRestore:false,proof:'fixture'},
    budgets:{npmJsonBytes:HARD_LIMITS.npmJsonBytes,metadataBytes:HARD_LIMITS.metadataBytes,manifestBytes:HARD_LIMITS.manifestBytes,outer:{...LEGACY_LIMITS},recursive:{unpackedBytes:LEGACY_LIMITS.unpackedBytes,entries:LEGACY_LIMITS.entries,depth:1,diskBytes:8*1024**3,memoryBytes:HARD_LIMITS.memoryBytes}},proofs:[{name:'test',status:'verified',evidence:'fixture'}] };
}
const bytes = record => Buffer.from(JSON.stringify(record));
const signed = record => signBytes(bytes(record), privateKey, keyId);

// Synthetic installed payloads must match the signed modes, independently of
// the runner's umask. Keep the runner and deliberately unsafe fixtures intact.
async function writeInstalledFile(path, content, mode = 0o644) {
  await writeFile(path, content, { mode });
  await chmod(path, mode);
}

test('sealing under a restrictive umask produces canonical modes without following links', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { symlink, link, stat } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'full-release-restrictive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = join(root, 'package');
  await mkdir(join(pkg, 'runtime'), { recursive: true, mode: 0o700 });
  await mkdir(join(pkg, 'web'), { mode: 0o700 });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: trust.packageName, version: '1.0.0', files: ['runtime', 'web'], opencraftWeb: { schemaVersion: 1, workerProtocol: 1, buildId: 'fixture' } }), { mode: 0o600 });
  await writeFile(join(pkg, 'web/version.json'), JSON.stringify({ buildId: 'fixture', sourceRevision: source }), { mode: 0o600 });
  await writeFile(join(pkg, 'LICENSE'), 'license', { mode: 0o600 });
  await writeFile(join(pkg, 'runtime/main.mjs'), 'console.log(1)', { mode: 0o600 });
  await writeFile(join(pkg, 'runtime/run'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const outside = join(root, 'outside');
  await writeFile(outside, 'outside', { mode: 0o600 });
  await symlink(outside, join(pkg, 'runtime/omitted-link'));
  const key = join(root, 'key.pem');
  await writeFile(key, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const args = { packageRoot: pkg, directory: root, template: fixture(), keyPath: key, keyId };
  const script = `import { sealPackage } from ${JSON.stringify(new URL('../../scripts/full-release/producer.mjs', import.meta.url).href)}; process.umask(0o077); console.log(JSON.stringify(await sealPackage(${JSON.stringify(args)})));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script]);
  const packed = JSON.parse(stdout);
  const verified = await verifyFullArchive(join(root, packed.filename), trust);
  assert.equal(acceptReleasePolicy(verified.record, await readFile(join(pkg, 'release/upgrade-policy.json'))).recipes.length, 0);
  assert.equal(verified.files.find(([path]) => path === 'runtime/main.mjs')[3], '0644');
  assert.equal(verified.files.find(([path]) => path === 'runtime/run')[3], '0755');
  for (const path of ['release/full-release.json', 'release/full-release.sig']) assert.ok(verified.captured.has(path));
  assert.ok(!verified.files.some(([path]) => path === 'runtime/omitted-link'));
  assert.equal((await stat(outside)).mode & 0o7777, 0o600);
  assert.equal((await stat(key)).mode & 0o7777, 0o600);
  await link(outside, join(pkg, 'runtime/hard-link'));
  await assert.rejects(npmPack(pkg, root), /hard links/);
  assert.equal((await stat(outside)).mode & 0o7777, 0o600);
});

test('uncompressed signing inventory follows npm inclusion and ignore rules', async t => {
  const root = await mkdtemp(join(tmpdir(), 'inventory-rules-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const pkg=join(root,'pkg'); await mkdir(join(pkg,'runtime'),{recursive:true});
  await writeFile(join(pkg,'package.json'),JSON.stringify({name:'inventory',version:'1.0.0',files:['runtime'],bin:'runtime/main.mjs'}));
  await writeFile(join(pkg,'LICENSE'),'license'); await writeFile(join(pkg,'outside'),'not shipped');
  await writeFile(join(pkg,'runtime/main.mjs'),'export const a=1');
  await writeFile(join(pkg,'runtime/.npmignore'),'ignored.txt\n');
  await writeFile(join(pkg,'runtime/ignored.txt'),'not shipped either');
  const inventory=await stagedInventory(pkg), packed=await npmPack(pkg,root);
  const scan=await verifyInventoryArchive(join(root,packed.filename));
  assert.deepEqual(inventory,scan.files);
  assert.ok(!inventory.some(([name])=>name.includes('ignored')||name==='outside'));
});

test('strict parser rejects duplicate keys, unsafe numbers, invalid UTF8 and depth', () => {
  for (const input of ['{"x":1,"x":2}','{"x":1,"\\u0078":2}','{"n":9007199254740992}','{"n":1e999}','[1,]', '['.repeat(66)+'0'+']'.repeat(66), Buffer.from([0xff])]) assert.throws(() => parseStrictJson(input));
  assert.equal(parseStrictJson('{"x":1}').x,1);
});
test('formal manifest requires all sections and rejects unknown fields', () => {
  assert.equal(parseManifest(bytes(fixture())).kind,'opencraft.full-release');
  for (const key of Object.keys(fixture())) { const record=fixture(); delete record[key]; assert.throws(()=>parseManifest(bytes(record)),key); }
  const unknown=fixture();unknown.extra=true;assert.throws(()=>parseManifest(bytes(unknown)));
});
test('raw signature rejects mutation, unknown key and wrong algorithm', () => {
  const record=fixture(), raw=bytes(record), sig=signed(record);
  assert.equal(acceptManifest(raw,sig,trust).state.highestSequence,1);
  assert.throws(()=>acceptManifest(Buffer.concat([raw,Buffer.from(' ')]),sig,trust));
  for(const mutation of [{keyId:'other'},{algorithm:'RSA'},{signature:'A'.repeat(86)+'=='}]) assert.throws(()=>acceptManifest(raw,{...sig,...mutation},trust));
});
test('anti-replay permits only exact-byte retry and retains highest sequence', () => {
  const record=fixture(), first=acceptManifest(bytes(record),signed(record),trust);
  assert.equal(acceptManifest(bytes(record),signed(record),trust,first.state).state.manifestSha256,first.state.manifestSha256);
  record.rollback.proof='changed';assert.throws(()=>acceptManifest(bytes(record),signed(record),trust,first.state),/collision/);
  record.release.releaseSequence=2;const next=acceptManifest(bytes(record),signed(record),trust,first.state);
  const old=fixture();assert.throws(()=>acceptManifest(bytes(old),signed(old),trust,next.state),/replay/);
});
test('revocation, stale watermarks and expiry reject new installs', () => {
  for(const mutate of [r=>r.revocations.keyIds.push(keyId),r=>r.revocations.releaseIds.push(r.release.releaseId),r=>r.release.expiresAt=new Date(now-500).toISOString()]) {
    const record=fixture();mutate(record);assert.throws(()=>acceptManifest(bytes(record),signed(record),trust));
  }
  const record=fixture();assert.throws(()=>acceptManifest(bytes(record),signed(record),trust,{revocationSequence:2}));
  assert.throws(()=>acceptManifest(bytes(record),signed(record),trust,{revokedReleaseIds:['test-release']}));
});
test('aliases, overlapping roots, duplicate components and unsafe modes are rejected', () => {
  for(const path of ['../LICENSE','/LICENSE','x\\LICENSE','x//LICENSE','x/./LICENSE','e\u0301','a\u0000b']) {
    const record=fixture();record.components[0].fileList[0][0]=path;record.components[0].content.fileListSha256=fileListDigest(record.components[0].fileList);assert.throws(()=>parseManifest(bytes(record)),path);
  }
  for(const mode of ['0777','04755',644]) { const record=fixture();record.components[0].fileList[0][3]=mode;record.components[0].content.fileListSha256=fileListDigest(record.components[0].fileList);assert.throws(()=>parseManifest(bytes(record))); }
  const duplicate=fixture();duplicate.components.push(structuredClone(duplicate.components[0]));assert.throws(()=>parseManifest(bytes(duplicate)));
});
test('small signed preflight checks bootstrap, platform and legacy bridge budgets', () => {
  const record=fixture(), metadata=signPreflight(record,privateKey,keyId);
  assert.ok(Buffer.byteLength(JSON.stringify(metadata))<64*1024);
  assert.equal(verifyPreflight(metadata,trust).release.releaseId,record.release.releaseId);
  assert.throws(()=>verifyPreflight({...metadata,payload:Buffer.from('{}').toString('base64')},trust));
  record.updater.minBootstrap=2;assert.throws(()=>verifyPreflight(signPreflight(record,privateKey,keyId),trust),/maintenance/);
  record.updater.minBootstrap=1;record.budgets.outer.archiveBytes=LEGACY_LIMITS.archiveBytes+1;
  assert.throws(()=>verifyPreflight(signPreflight(record,privateKey,keyId),trust));
  record.budgets.outer.archiveBytes=LEGACY_LIMITS.archiveBytes;record.targets[0].nodeAbi++;
  assert.throws(()=>verifyPreflight(signPreflight(record,privateKey,keyId),trust),/incompatible/);
});
test('persistent high-water mark survives reopening and corrupt state fails closed', async t => {
  const root=await mkdtemp(join(tmpdir(),'full-release-state-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'state.json');
  const record=fixture(), state=acceptManifest(bytes(record),signed(record),trust).state;
  await writeReplayState(path,state);assert.deepEqual({...await readReplayState(path)},state);
  await writeFile(path,'{}');await assert.rejects(readReplayState(path));
});
test('final npm tgz includes manifest/signature and rejects extra code and missing signature', async t => {
  const root=await mkdtemp(join(tmpdir(),'full-release-pack-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const pkg=join(root,'package');await mkdir(pkg);await writeFile(join(pkg,'package.json'),JSON.stringify({name:trust.packageName,version:'1.0.0',files:['runtime','web'],opencraftWeb:{schemaVersion:1,workerProtocol:1,buildId:'fixture'}}));
  await mkdir(join(pkg,'web'));await writeFile(join(pkg,'web/version.json'),JSON.stringify({buildId:'fixture',sourceRevision:source}));
  await mkdir(join(pkg,'runtime'));await writeFile(join(pkg,'runtime/main.mjs'),'console.log(1)');await writeFile(join(pkg,'LICENSE'),'license');
  const key=join(root,'key.pem');await writeFile(key,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  const record=fixture();const packed=await sealPackage({packageRoot:pkg,directory:root,template:record,keyPath:key,keyId});
  const verified=await verifyFullArchive(join(root,packed.filename),trust);
  assert.ok(verified.captured.has('release/full-release.json'));assert.ok(verified.captured.has('release/full-release.sig'));
  assert.ok(verified.files.some(([path])=>path==='LICENSE'));
  await writeInstalledFile(join(pkg,'runtime/injected.mjs'),'console.log(2)');
  const bad=join(root,'bad.tgz');await c({file:bad,gzip:true,cwd:root,portable:true},['package']);await assert.rejects(verifyFullArchive(bad,trust),/file list/);
  await rm(join(pkg,'runtime/injected.mjs'));await rm(join(pkg,'release/full-release.sig'));await c({file:bad,gzip:true,cwd:root,portable:true},['package']);await assert.rejects(verifyFullArchive(bad,trust),/signature is missing/);
  await chmod(key,0o644);await assert.rejects(sealPackage({packageRoot:pkg,directory:root,template:fixture(),keyPath:key,keyId}),/0600/);
});

test('npm preflight rejects unsupported bootstrap before any pack/download', async t => {
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  const root=await mkdtemp(join(tmpdir(),'full-release-preflight-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const record=fixture();record.updater.minBootstrap=2;
  const manifest={name:trust.packageName,version:'1.0.0',dist:{integrity:'sha512-YWJj'},opencraftWeb:{schemaVersion:1,workerProtocol:1,buildId:'fixture'},opencraftFullRelease:signPreflight(record,privateKey,keyId)};
  // A deployment temp directory may belong to a CommonJS package.
  await writeFile(join(root,'package.json'),JSON.stringify({type:'commonjs'}));
  await writeFile(join(root,'metadata.json'),JSON.stringify(manifest));
  const npm=join(root,'npm.mjs');await writeInstalledFile(npm,`#!${process.execPath}\nimport fs from 'node:fs';fs.appendFileSync(${JSON.stringify(join(root,'calls'))},process.argv[2]+'\\n');console.log(fs.readFileSync(${JSON.stringify(join(root,'metadata.json'))},'utf8'));`,0o755);
  const source=new URL('../../scripts/web-deployment/releases.mjs',import.meta.url).href;
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',`const {createNpmReleaseSource}=await import(${JSON.stringify(source)});try{await createNpmReleaseSource({registry:${JSON.stringify(trust.registry)},channel:'test',packageName:${JSON.stringify(trust.packageName)}}).latest();process.exitCode=2;}catch(error){console.log(error.message);}`],{env:{...process.env,OPENCRAFT_NPM_EXECUTABLE:npm,OPENCRAFT_NPM_PACKAGE_NAME:trust.packageName,OPENCRAFT_FULL_RELEASE_TRUST_JSON:JSON.stringify(trust)}});
  assert.match(stdout,/requires bootstrap maintenance/);
  const {readFile}=await import('node:fs/promises');assert.equal(await readFile(join(root,'calls'),'utf8'),'view\n');
});

test('link, duplicate-path and layered-budget failures return errors without crashing the updater', async t => {
  const {Header}=await import('tar');const {gzipSync}=await import('node:zlib');
  const {scanArchive}=await import('../../scripts/full-release/archive.mjs');
  const root=await mkdtemp(join(tmpdir(),'full-release-unsafe-'));t.after(()=>rm(root,{recursive:true,force:true}));
  // Encode malformed fixtures directly: tar's gzip writer can fail while
  // constructing duplicate-path archives on Node26, before the scanner runs.
  async function archive(name,entries) {
    const chunks=[];
    for(const entry of entries) {
      const body=entry.type==='File'?Buffer.from('test'):Buffer.alloc(0),block=Buffer.alloc(512);
      new Header({mode:0o644,uid:0,gid:0,...entry,size:body.length}).encode(block);chunks.push(block);
      if(body.length)chunks.push(body,Buffer.alloc(512-body.length));
    }
    chunks.push(Buffer.alloc(1024));const path=join(root,name+'.tgz');await writeFile(path,gzipSync(Buffer.concat(chunks)));return path;
  }
  for(const type of ['SymbolicLink','Link']) {
    const path=await archive(type,[{path:'package/link.mjs',type,linkpath:'package/main.mjs'}]);await assert.rejects(scanArchive(path),/Unsafe/);
  }
  const duplicate=await archive('duplicate',[{path:'package/main.mjs',type:'File'},{path:'package/main.mjs',type:'File'}]);
  for(let attempt=0;attempt<20;attempt++) await assert.rejects(scanArchive(duplicate),/Unsafe/);
  const bounded=await archive('budget',[{path:'package/main.mjs',type:'File'}]);
  await assert.rejects(scanArchive(bounded,{...HARD_LIMITS,unpackedBytes:1}),/budget/);await assert.rejects(scanArchive(bounded,{...HARD_LIMITS,archiveBytes:1}),/budget/);
});

test('explicit retained rollback verifies signature/content and cannot bypass revocation', async t => {
  const {verifyRetainedRelease}=await import('../../scripts/full-release/retained.mjs');
  const root=await mkdtemp(join(tmpdir(),'full-release-retained-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const record=fixture();await mkdir(join(root,'release'));await writeInstalledFile(join(root,'LICENSE'),'license');
  await writeFile(join(root,'release/full-release.json'),bytes(record));await writeFile(join(root,'release/full-release.sig'),JSON.stringify(signed(record)));
  const high={highestSequence:7,revocationSequence:1};
  const intent=await verifyRetainedRelease(root,trust,high);assert.equal(intent.releaseSequence,1);assert.equal(intent.highestSequence,7);assert.equal(high.highestSequence,7);
  await assert.rejects(verifyRetainedRelease(root,trust,{...high,revokedReleaseIds:['test-release']}),/policy/);
  await chmod(join(root,'LICENSE'),0o600);await assert.rejects(verifyRetainedRelease(root,trust,high),/changed/);
  await chmod(join(root,'LICENSE'),0o644);
  await writeFile(join(root,'LICENSE'),'changed');await assert.rejects(verifyRetainedRelease(root,trust,high),/changed/);
});

test('the signing owner rejects different builds under one identity and preserves the original tgz', async t => {
  const {readFile}=await import('node:fs/promises');
  const root=await mkdtemp(join(tmpdir(),'full-release-binding-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const pkg=join(root,'package');await mkdir(join(pkg,'web'),{recursive:true});await mkdir(join(pkg,'runtime'));
  const manifest={name:trust.packageName,version:'1.0.0',files:['web','runtime'],opencraftWeb:{schemaVersion:1,workerProtocol:1,buildId:'build-one'}};
  await writeFile(join(pkg,'package.json'),JSON.stringify(manifest));await writeFile(join(pkg,'web/version.json'),JSON.stringify({buildId:'build-one',sourceRevision:source}));
  await writeFile(join(pkg,'runtime/main.mjs'),'original');await writeFile(join(pkg,'LICENSE'),'license');
  const key=join(root,'key.pem');await writeFile(key,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  const args={packageRoot:pkg,directory:root,template:fixture(),keyPath:key,keyId};
  const first=await sealPackage(args), original=await readFile(join(root,first.filename));
  assert.equal((await sealPackage(args)).integrity,first.integrity);
  manifest.opencraftWeb.buildId='build-two';await writeFile(join(pkg,'package.json'),JSON.stringify(manifest));
  await writeFile(join(pkg,'web/version.json'),JSON.stringify({buildId:'build-two',sourceRevision:source}));
  await assert.rejects(sealPackage(args),/new release identity/);
  assert.deepEqual(await readFile(join(root,first.filename)),original);
  await verifyFullArchive(join(root,first.filename),trust);
});

test('revocation refresh permits an unrevoked signed rollback while retaining both high-water marks', async t => {
  const {verifyRetainedRelease}=await import('../../scripts/full-release/retained.mjs');
  const root=await mkdtemp(join(tmpdir(),'full-release-revocation-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const record=fixture();await mkdir(join(root,'release'));await writeInstalledFile(join(root,'LICENSE'),'license');
  await writeFile(join(root,'release/full-release.json'),bytes(record));await writeFile(join(root,'release/full-release.sig'),JSON.stringify(signed(record)));
  const state={highestSequence:7,revocationSequence:2,revokedKeyIds:[],revokedReleaseIds:['some-other-release']};
  const intent=await verifyRetainedRelease(root,trust,state);
  assert.equal(intent.releaseSequence,1);assert.equal(state.highestSequence,7);assert.equal(state.revocationSequence,2);
  await assert.rejects(verifyRetainedRelease(root,trust,{...state,revokedKeyIds:[keyId]}),/policy/);
  await assert.rejects(verifyRetainedRelease(root,trust,{...state,revokedReleaseIds:['test-release']}),/policy/);
});

test('first bootstrap initializes authenticated state and reopening or explicit rollback never lowers it', async t => {
  const {initializeReplayState}=await import('../../scripts/full-release/retained.mjs');
  const root=await mkdtemp(join(tmpdir(),'full-release-initial-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'release'));await writeInstalledFile(join(root,'LICENSE'),'license');const stateFile=join(root,'state.json');
  const record=fixture();record.release.releaseSequence=5;record.revocations.sequence=2;
  const save=async()=>{await writeFile(join(root,'release/full-release.json'),bytes(record));await writeFile(join(root,'release/full-release.sig'),JSON.stringify(signed(record)));};
  await save();await initializeReplayState(root,trust,stateFile);
  assert.equal((await readReplayState(stateFile)).highestSequence,5);
  await initializeReplayState(root,trust,stateFile);
  record.release.releaseSequence=1;record.revocations.sequence=1;await save();
  await assert.rejects(initializeReplayState(root,trust,stateFile),/committed activation identity/);
  await initializeReplayState(root,trust,stateFile,{manifestSha256:sha256(bytes(record)),releaseId:record.release.releaseId,releaseSequence:1,authorization:'verified-installation'});
  const state=await readReplayState(stateFile);assert.equal(state.highestSequence,5);assert.equal(state.revocationSequence,2);
  assert.throws(()=>acceptManifest(bytes(record),signed(record),trust,state));
});

test('root and explicit directory modes are validated and extracted ownership/modes are canonical', async t => {
  const {Header}=await import('tar');const {gzipSync}=await import('node:zlib');
  const {stat}=await import('node:fs/promises');
  const {scanArchive}=await import('../../scripts/full-release/archive.mjs');
  const {unpackPackage}=await import('../../scripts/web-deployment/releases.mjs');
  const root=await mkdtemp(join(tmpdir(),'full-release-modes-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const archive=join(root,'payload.tgz');
  function archiveBytes(rootMode, directoryMode) {
    const chunks=[];
    for(const entry of [{path:'package/',type:'Directory',mode:rootMode},{path:'package/runtime/',type:'Directory',mode:directoryMode},{path:'package/runtime/main.mjs',type:'File',mode:0o755}]) {
      const body=entry.type==='File'?Buffer.from('code'):Buffer.alloc(0);
      const block=Buffer.alloc(512);new Header({...entry,uid:4242,gid:4343,size:body.length}).encode(block);chunks.push(block);
      if(body.length) chunks.push(body,Buffer.alloc(512-body.length));
    }
    chunks.push(Buffer.alloc(1024));return gzipSync(Buffer.concat(chunks));
  }
  await writeFile(archive,archiveBytes(0o7777,0o755));await assert.rejects(scanArchive(archive),/directory mode/);
  await writeFile(archive,archiveBytes(0o755,0o7777));await assert.rejects(scanArchive(archive),/directory mode/);
  await writeFile(archive,archiveBytes(0o755,0o755));await scanArchive(archive);
  const previous=process.umask(0o077);let installed;
  try { installed=await unpackPackage(archive,join(root,'unpacked'),HARD_LIMITS); } finally { process.umask(previous); }
  for(const path of [installed,join(installed,'runtime'),join(installed,'runtime/main.mjs')]) {
    const info=await stat(path);assert.equal(info.mode&0o7777,0o755);
    if(process.getuid) { assert.equal(info.uid,process.getuid());assert.equal(info.gid,process.getgid()); }
  }
});

test('signed managed updates preserve the activated current through failed staging, rollback, another failed update and restart', {timeout:60000}, async t => {
  const {readFile}=await import('node:fs/promises');const {promisify}=await import('node:util');const {execFile}=await import('node:child_process');
  const root=await mkdtemp(join(tmpdir(),'full-release-service-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const key=join(root,'key.pem');await writeFile(key,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  const packages={};
  const worker=`import {createServer} from 'node:http';import {readFile} from 'node:fs/promises';import {join} from 'node:path';
const root=process.env.OPENCRAFT_RELEASE_ROOT,pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8')),version=JSON.parse(await readFile(join(root,'web/version.json'),'utf8'));
if(pkg.version==='1.3.0')process.exit(1);
const server=createServer((request,response)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify(request.url==='/__opencraft_health'?{ok:true}:version));});
server.listen(0,'127.0.0.1',()=>process.send({protocol:1,version:pkg.version,buildId:version.buildId,port:server.address().port}));`;
  for(const n of [1,2,3]) {
    const version=`1.${n}.0`,directory=join(root,version),pkg=join(directory,'package');await mkdir(join(pkg,'web'),{recursive:true});await mkdir(join(pkg,'runtime'));
    const buildId=`build-${version}`;await writeFile(join(pkg,'package.json'),JSON.stringify({name:trust.packageName,version,files:['runtime','web'],opencraftWeb:{schemaVersion:1,workerProtocol:1,buildId}}));
    await writeFile(join(pkg,'web/index.html'),`<meta content="${buildId}">`);await writeFile(join(pkg,'web/version.json'),JSON.stringify({buildId,sourceRevision:source}));
    await writeFile(join(pkg,'runtime/worker.mjs'),worker);await writeFile(join(pkg,'LICENSE'),'license');
    const record=fixture();record.release.releaseSequence=n;record.release.releaseId=`test-release-${n}`;record.transport.exactVersion=version;
    const packed=await sealPackage({packageRoot:pkg,directory,template:record,keyPath:key,keyId});packages[version]={version,buildId,archive:join(directory,packed.filename),packageRoot:pkg,integrity:packed.integrity,manifestSha256:packed.fullRelease.manifestSha256};
  }
  await writeFile(join(root,'packages.json'),JSON.stringify(packages));
  const serverUrl=new URL('../../scripts/web-deployment/server.mjs',import.meta.url).href;
  const stateUrl=new URL('../../scripts/full-release/archive.mjs',import.meta.url).href;
  const scenario=`import assert from 'node:assert/strict';import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';import {join} from 'node:path';
import {createManagedWebServer} from ${JSON.stringify(serverUrl)};import {readReplayState} from ${JSON.stringify(stateUrl)};
const root=process.argv[2],packages=JSON.parse(await readFile(join(root,'packages.json'),'utf8'));
async function run(name,rollback,tree=false) {
 const stateDirectory=join(root,name);let selected='1.3.0',app,base,cookie='';
 const source={channel:'test',latest:async()=>packages[selected],download:async(release,directory)=>{await mkdir(directory,{recursive:true});const path=join(directory,'release.tgz');await copyFile(packages[release.version].archive,path);return path;}};
 const execution={status:async()=>null,apply:async()=>{},inspect:async(release)=>{if(!rollback&&release.version==='1.3.0')throw new Error('Synthetic preparation failure');},referencedRoots:async()=>[]};
 const post=(action,input={})=>fetch(base+'/__opencraft_updates/'+action,{method:'POST',headers:{origin:base,cookie,'content-type':'application/json'},body:JSON.stringify(input)});
 const status=async()=>await(await fetch(base+'/__opencraft_updates',{headers:{cookie}})).json();
 async function until(predicate){const end=Date.now()+10000;while(Date.now()<end){const value=await status();if(predicate(value))return value;await new Promise(r=>setTimeout(r,20));}throw new Error('Managed test timed out');}
 async function open(){cookie='';app=await createManagedWebServer({initialRelease:packages['1.1.0'].packageRoot,stateDirectory,source,execution});base='http://127.0.0.1:'+(await app.listen({port:0})).port;const key=(await readFile(app.adminKeyPath,'utf8')).trim();const login=await post('login',{key});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];}
 async function install(version,phase){selected=version;if(tree){assert.equal((await status()).localTreeInstall,1);assert.equal((await post('install-local-tree',{...packages[version],tree:packages[version].packageRoot})).status,202);}else if(!rollback){assert.equal((await post('install-local',packages[version])).status,202);}else{assert.equal((await post('check')).status,202);await until(s=>!s.checking&&s.latest?.version===version);assert.equal((await post('install',{version})).status,202);}return until(s=>s.job?.phase===phase);}
 try {
  await open();const initial=JSON.parse(await readFile(join(stateDirectory,'deployment.json'),'utf8')).current.fullRelease;
  assert.ok(initial.manifestSha256);
  if(rollback){assert.equal((await install('1.2.0','completed')).current.version,'1.2.0');assert.equal((await post('rollback')).status,202);assert.equal((await until(s=>s.job?.phase==='completed')).current.version,'1.1.0');assert.equal((await readReplayState(join(stateDirectory,'full-release-state.json'))).highestSequence,2);}
  const failed=await install('1.3.0','failed');assert.equal(failed.current.version,'1.1.0');assert.equal((await readReplayState(join(stateDirectory,'full-release-state.json'))).highestSequence,3);
  const persisted=JSON.parse(await readFile(join(stateDirectory,'deployment.json'),'utf8'));assert.equal(persisted.current.fullRelease.manifestSha256,initial.manifestSha256);assert.equal(persisted.job.phase,'failed');
  await app.close();app=null;await open();assert.equal((await status()).current.version,'1.1.0');assert.equal((await(await fetch(base+'/version.json')).json()).buildId,packages['1.1.0'].buildId);
  const high=(await readReplayState(join(stateDirectory,'full-release-state.json'))).highestSequence;assert.equal(high,3);
  await app.close();app=null;
  // An interrupted future job also leaves committed current authorization intact.
  persisted.job={id:'interrupted',version:'1.3.0',phase:'downloading',error:null};await writeFile(join(stateDirectory,'deployment.json'),JSON.stringify(persisted));await open();assert.equal((await status()).current.version,'1.1.0');assert.equal((await status()).job.phase,'failed');
  return {current:(await status()).current.version,highest:high};
 } finally {if(app)await app.close();}
}
console.log(JSON.stringify({preparationFailure:await run('prepare',false),rollbackThenWorkerFailure:await run('rollback',true),treePreparationFailure:await run('tree-prepare',false,true),treeRollback:await run('tree-rollback',true,true)}));`;
  const path=join(root,'scenario.mjs');await writeFile(path,scenario);
  const {stdout}=await promisify(execFile)(process.execPath,[path,root],{timeout:45000,maxBuffer:1024*1024,env:{...process.env,OPENCRAFT_FULL_RELEASE_TRUST_JSON:JSON.stringify(trust),OPENCRAFT_NPM_PACKAGE_NAME:trust.packageName}});
  assert.deepEqual(JSON.parse(stdout.trim()),{preparationFailure:{current:'1.1.0',highest:3},rollbackThenWorkerFailure:{current:'1.1.0',highest:3},treePreparationFailure:{current:'1.1.0',highest:3},treeRollback:{current:'1.1.0',highest:3}});
});

test('complete tree components remain consumable by the fixed bridge contract and match final dry-run',async t=>{
 const root=await mkdtemp(join(tmpdir(),'full-release-components-'));t.after(()=>rm(root,{recursive:true,force:true}));const pkg=join(root,'package'),key=join(root,'key.pem');
 for(const dir of ['web','runtime','execution','node_modules/library','full/core','full/codex','full/dsh','release']){await mkdir(join(pkg,dir),{recursive:true});await writeFile(join(pkg,dir,'LICENSE'),'MIT');}
 await writeFile(key,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
 await writeFile(join(pkg,'package.json'),JSON.stringify({name:trust.packageName,version:'1.0.0',license:'MIT',files:['web','runtime','execution','full','release'],opencraftWeb:{schemaVersion:1,workerProtocol:1,buildId:'fixture'}}));await writeFile(join(pkg,'LICENSE'),'MIT');await writeFile(join(pkg,'README.md'),'Deployment');await writeFile(join(pkg,'runtime/main.mjs'),'code');await writeFile(join(pkg,'web/version.json'),JSON.stringify({sourceRevision:source,buildId:'fixture'}));
 const template=fixture();template.updater.bridge=false;const packed=await sealPackage({packageRoot:pkg,directory:root,template,keyPath:key,keyId}),checked=await verifyFullArchive(join(root,packed.filename),trust);
 assert.ok(checked.record.components.some(c=>c.role==='core'));assert.ok(checked.record.components.some(c=>c.role==='cli'));assert.ok(checked.record.components.some(c=>c.role==='dsh'));assert.equal(packed.fullRelease.dryRun.integrity,packed.integrity);assert.equal(packed.fullRelease.dryRun.entries,checked.entries);assert.match(await readFile(join(pkg,'README.md'),'utf8'),/SPDX-License-Identifier: Apache-2.0/);
});

test('signed npm consumer streams the pinned URL and rejects oversized bytes before tar parsing', {timeout:60000}, async t => {
  const {createServer}=await import('node:https');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
  const root=await mkdtemp(join(tmpdir(),'signed-npm-stream-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const tlsKey=join(root,'tls-key'),cert=join(root,'tls-cert');await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',tlsKey,'-out',cert,'-days','1','-subj','/CN=localhost']);
  let metadata,archiveBytes,oversize=false;const paths=[];
  const server=createServer({key:await readFile(tlsKey),cert:await readFile(cert)},(request,response)=>{
    paths.push(request.url);
    if(request.url==='/npm/app.tgz'){if(oversize){response.write(Buffer.alloc(20000));response.end();}else response.end(archiveBytes);return;}
    if(request.url.startsWith('/npm/@example')){const version={...metadata};if(request.headers.accept?.includes('install-v1'))version.dist={...version.dist,tarball:'https://unverified.invalid/app.tgz'};response.setHeader('content-type','application/json');response.end(JSON.stringify({name:metadata.name,'dist-tags':{test:'1.0.0'},versions:{'1.0.0':version}}));return;}
    response.writeHead(404);response.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const registry='https://127.0.0.1:'+server.address().port+'/npm/',localTrust={...trust,registry};
  const pkg=join(root,'package');await mkdir(join(pkg,'runtime'),{recursive:true});await mkdir(join(pkg,'web'));
  await writeFile(join(pkg,'package.json'),JSON.stringify({name:trust.packageName,version:'1.0.0',files:['runtime','web','release'],opencraftWeb:{schemaVersion:1,workerProtocol:1,buildId:'fixture'}}));
  await writeFile(join(pkg,'runtime/main.mjs'),'code');await writeFile(join(pkg,'LICENSE'),'license');await writeFile(join(pkg,'web/version.json'),JSON.stringify({sourceRevision:source,buildId:'fixture'}));
  const key=join(root,'signer');await writeFile(key,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});const record=fixture();record.transport.registry=registry;record.budgets.outer.archiveBytes=16384;
  const packed=await sealPackage({packageRoot:pkg,directory:root,template:record,keyPath:key,keyId});archiveBytes=await readFile(join(root,packed.filename));metadata=JSON.parse(await readFile(join(pkg,'package.json'),'utf8'));metadata.dist={integrity:packed.integrity,tarball:registry+'app.tgz'};
  const userconfig=join(root,'npmrc');await writeFile(userconfig,'strict-ssl=false\ncache='+join(root,'npm-cache')+'\n',{mode:0o600});
  const module=new URL('../../scripts/web-deployment/releases.mjs',import.meta.url).href;
  const script=`const {createNpmReleaseSource}=await import(${JSON.stringify(module)});const source=createNpmReleaseSource({registry:${JSON.stringify(registry)},channel:'test',packageName:${JSON.stringify(trust.packageName)},userconfig:${JSON.stringify(userconfig)}});try{const selected=await source.latest();await source.download(selected,process.argv[1]);console.log('download verified');}catch(error){console.log(error.message);process.exitCode=1;}`;
  const options={env:{...process.env,OPENCRAFT_NPM_PACKAGE_NAME:trust.packageName,OPENCRAFT_FULL_RELEASE_TRUST_JSON:JSON.stringify(localTrust)},timeout:30000,maxBuffer:65536};
  const positive=await promisify(execFile)(process.execPath,['--input-type=module','-e',script,join(root,'download')],options);assert.match(positive.stdout,/download verified/);assert.equal(paths.filter(p=>p==='/npm/app.tgz').length,1);
  oversize=true;await assert.rejects(promisify(execFile)(process.execPath,['--input-type=module','-e',script,join(root,'oversize')],options),error=>error.stdout.includes('Signed release stream download failed'));await assert.rejects(readFile(join(root,'oversize/release.tgz')),{code:'ENOENT'});
});


test('streamed sealing with default compression is byte-identical to npm pack', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seal-npm-equivalence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousCache = process.env.OPENCRAFT_PACKAGE_CACHE_DIR;
  process.env.OPENCRAFT_PACKAGE_CACHE_DIR = join(root, 'selection-cache');
  t.after(() => { if (previousCache === undefined) delete process.env.OPENCRAFT_PACKAGE_CACHE_DIR; else process.env.OPENCRAFT_PACKAGE_CACHE_DIR = previousCache; });
  const pkg = join(root, 'pkg'); await mkdir(join(pkg, 'runtime'), { recursive: true });
  await mkdir(join(pkg, 'web')); await mkdir(join(root, 'npm'));
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: trust.packageName, version: '1.0.0', files: ['runtime', 'web'], dependencies: { 'equivalence-dep': '1.0.0' }, bundleDependencies: ['equivalence-dep'], bin: 'runtime/main.mjs', opencraftWeb: { buildId: 'fixture' } }));
  await mkdir(join(pkg, 'node_modules/equivalence-dep'), { recursive: true });
  await writeFile(join(pkg, 'node_modules/equivalence-dep/package.json'), JSON.stringify({ name: 'equivalence-dep', version: '1.0.0', main: 'index.js' }));
  await writeFile(join(pkg, 'node_modules/equivalence-dep/index.js'), 'module.exports=1');
  await writeFile(join(pkg, 'runtime/main.mjs'), 'console.log(1)');
  await writeFile(join(pkg, 'runtime/.npmignore'), 'hidden.txt\n');
  await writeFile(join(pkg, 'runtime/hidden.txt'), 'must not ship');
  await writeFile(join(pkg, 'web/version.json'), JSON.stringify({ buildId: 'fixture', sourceRevision: source }));
  await writeFile(join(pkg, 'LICENSE'), 'license');
  const key = join(root, 'key.pem'); await writeFile(key, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const args = { packageRoot: pkg, directory: root, template: fixture(), keyPath: key, keyId };
  const sealed = await sealPackage({ ...args, gzipLevel: 9 });
  const npm = await npmPack(pkg, join(root, 'npm'));
  assert.equal(sealed.integrity, npm.integrity);
  assert.deepEqual(await readFile(join(root, sealed.filename)), await readFile(join(root, 'npm', npm.filename)));
  assert.deepEqual(sealed.files, npm.files);
  assert.deepEqual(sealed.bundled, npm.bundled);
  assert.equal(sealed.entryCount, npm.entryCount);
  assert.equal(sealed.unpackedSize, npm.unpackedSize);
  const retry = await sealPackage({ ...args, gzipLevel: 9 });
  assert.equal(retry.integrity, sealed.integrity);
  await assert.rejects(sealPackage({ ...args, gzipLevel: 3 }), /archive identity changed/);
});

test('signed metadata excluded by npm rules is rejected before sealing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seal-metadata-ignore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = join(root, 'pkg'); await mkdir(join(pkg, 'web'), { recursive: true });
  await mkdir(join(pkg, 'release'));
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: trust.packageName, version: '1.0.0', files: ['web', 'release'], opencraftWeb: { buildId: 'fixture' } }));
  await writeFile(join(pkg, 'web/version.json'), JSON.stringify({ buildId: 'fixture', sourceRevision: source }));
  await writeFile(join(pkg, 'LICENSE'), 'license');
  await writeFile(join(pkg, 'release/.npmignore'), 'full-release.*\n');
  const key = join(root, 'key.pem'); await writeFile(key, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await assert.rejects(sealPackage({ packageRoot: pkg, directory: root, template: fixture(), keyPath: key, keyId }), /exclude signed release metadata/);
});

test('package compression level rejects invalid configuration', async () => {
  const { packageGzipLevel } = await import('../../scripts/full-release/npm-archive.mjs');
  for (const value of ['', '0', '10', '3.5', 'fast', true]) assert.throws(() => packageGzipLevel(value));
  for (const value of ['1', 3, '9']) assert.equal(packageGzipLevel(value), Number(value));
});


test('prepared trees copy only signed payload, reject corruption and links, and defer an identical archive', async t => {
  const { symlink, stat, readdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'prepared-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = join(root, 'package'), key = join(root, 'key.pem');
  await mkdir(join(pkg, 'web'), { recursive: true });
  await mkdir(join(pkg, 'runtime'));
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: trust.packageName, version: '1.0.0', files: ['web', 'runtime'], opencraftWeb: { schemaVersion: 1, workerProtocol: 1, buildId: 'fixture' } }));
  await writeFile(join(pkg, 'web/version.json'), JSON.stringify({ buildId: 'fixture', sourceRevision: source }));
  await writeFile(join(pkg, 'runtime/main.mjs'), 'original');
  await writeFile(join(pkg, 'LICENSE'), 'license');
  await writeFile(key, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const prepared = await sealPackage({ packageRoot: pkg, directory: root, template: fixture(), keyPath: key, keyId, prepareOnly: true });
  assert.equal(prepared.integrity, undefined);
  assert.ok(!(await readdir(root)).some(name => name.endsWith('.tgz')));
  const options = { expectedManifestSha256: prepared.preparedTree.manifestSha256 };
  await writeFile(join(pkg, 'not-shipped'), 'ignored by npm');
  const accepted = await copyPreparedTree(pkg, join(root, 'installed'), trust, options);
  await assert.rejects(stat(join(root, 'installed/not-shipped')), { code: 'ENOENT' });
  assert.notEqual((await stat(join(pkg, 'runtime/main.mjs'))).ino, (await stat(join(root, 'installed/runtime/main.mjs'))).ino);
  await assert.rejects(copyPreparedTree(pkg, join(root, 'wrong-digest'), trust, { expectedManifestSha256: '0'.repeat(64) }), /manifest identity/);
  await assert.rejects(copyPreparedTree(pkg, join(root, 'replayed'), trust, { state: { ...accepted.state, highestSequence: 2 } }), /replay|sequence/i);
  const archiveArgs = { packageRoot: pkg, directory: root, trust, ...options, identityDirectory: prepared.preparedTree.identityDirectory };
  const packed = await archivePreparedPackage(archiveArgs);
  assert.equal((await verifyFullArchive(join(root, packed.filename), trust)).state.manifestSha256, options.expectedManifestSha256);
  assert.equal((await archivePreparedPackage(archiveArgs)).integrity, packed.integrity);
  await writeFile(join(pkg, 'runtime/main.mjs'), 'tampered');
  await assert.rejects(copyPreparedTree(pkg, join(root, 'corrupt'), trust, options), /digest mismatch/);
  await assert.rejects(archivePreparedPackage(archiveArgs), /mismatch|changed/);
  await rm(join(pkg, 'runtime/main.mjs'));
  await symlink(join(root, 'installed/runtime/main.mjs'), join(pkg, 'runtime/main.mjs'));
  await assert.rejects(copyPreparedTree(pkg, join(root, 'linked'), trust, options), /links/);
});
