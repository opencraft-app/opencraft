import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile, mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c } from 'tar';
import { parseStrictJson, parseManifest, fileListDigest, sha256, signBytes, acceptManifest,
  signPreflight, verifyPreflight, HARD_LIMITS, LEGACY_LIMITS } from '../../scripts/full-release/contract.mjs';
import { sealPackage, npmPack } from '../../scripts/full-release/producer.mjs';
import { verifyFullArchive, readReplayState, writeReplayState } from '../../scripts/full-release/archive.mjs';

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
  await writeFile(join(root,'metadata.json'),JSON.stringify(manifest));
  const npm=join(root,'npm');await writeInstalledFile(npm,`#!${process.execPath}\nimport fs from 'node:fs';fs.appendFileSync(${JSON.stringify(join(root,'calls'))},process.argv[2]+'\\n');console.log(fs.readFileSync(${JSON.stringify(join(root,'metadata.json'))},'utf8'));`,0o755);
  const source=new URL('../../scripts/web-deployment/releases.mjs',import.meta.url).href;
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',`const {createNpmReleaseSource}=await import(${JSON.stringify(source)});try{await createNpmReleaseSource({registry:${JSON.stringify(trust.registry)},channel:'test',packageName:${JSON.stringify(trust.packageName)}}).latest();process.exitCode=2;}catch(error){console.log(error.message);}`],{env:{...process.env,OPENCRAFT_NPM_EXECUTABLE:npm,OPENCRAFT_NPM_PACKAGE_NAME:trust.packageName,OPENCRAFT_FULL_RELEASE_TRUST_JSON:JSON.stringify(trust)}});
  assert.match(stdout,/requires bootstrap maintenance/);
  const {readFile}=await import('node:fs/promises');assert.equal(await readFile(join(root,'calls'),'utf8'),'view\n');
});

test('link, duplicate-path and layered-budget failures return errors without crashing the updater', async t => {
  const {symlink,link}=await import('node:fs/promises');
  const {scanArchive}=await import('../../scripts/full-release/archive.mjs');
  const root=await mkdtemp(join(tmpdir(),'full-release-unsafe-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const pkg=join(root,'package');await mkdir(pkg);await chmod(pkg,0o755);await writeInstalledFile(join(pkg,'main.mjs'),'test');
  let archive=join(root,'symlink.tgz');
  await symlink('main.mjs',join(pkg,'link.mjs'));await c({file:archive,cwd:root,gzip:true},['package']);
  await assert.rejects(scanArchive(archive),/Unsafe/);await rm(join(pkg,'link.mjs'));
  archive=join(root,'hardlink.tgz');
  await link(join(pkg,'main.mjs'),join(pkg,'link.mjs'));await c({file:archive,cwd:root,gzip:true},['package']);
  await assert.rejects(scanArchive(archive),/Unsafe/);await rm(join(pkg,'link.mjs'));
  archive=join(root,'duplicate.tgz');
  await c({file:archive,cwd:root,gzip:true},['package/main.mjs','package/main.mjs']);
  for (let attempt=0;attempt<20;attempt++) await assert.rejects(scanArchive(archive),/Unsafe/);
  archive=join(root,'budget.tgz');
  await c({file:archive,cwd:root,gzip:true},['package']);await assert.rejects(scanArchive(archive,{...HARD_LIMITS,unpackedBytes:1}),/budget/);
  await assert.rejects(scanArchive(archive,{...HARD_LIMITS,archiveBytes:1}),/budget/);
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
    const packed=await sealPackage({packageRoot:pkg,directory,template:record,keyPath:key,keyId});packages[version]={version,buildId,archive:join(directory,packed.filename),packageRoot:pkg,integrity:packed.integrity};
  }
  await writeFile(join(root,'packages.json'),JSON.stringify(packages));
  const serverUrl=new URL('../../scripts/web-deployment/server.mjs',import.meta.url).href;
  const stateUrl=new URL('../../scripts/full-release/archive.mjs',import.meta.url).href;
  const scenario=`import assert from 'node:assert/strict';import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';import {join} from 'node:path';
import {createManagedWebServer} from ${JSON.stringify(serverUrl)};import {readReplayState} from ${JSON.stringify(stateUrl)};
const root=process.argv[2],packages=JSON.parse(await readFile(join(root,'packages.json'),'utf8'));
async function run(name,rollback) {
 const stateDirectory=join(root,name);let selected='1.3.0',app,base,cookie='';
 const source={channel:'test',latest:async()=>packages[selected],download:async(release,directory)=>{await mkdir(directory,{recursive:true});const path=join(directory,'release.tgz');await copyFile(packages[release.version].archive,path);return path;}};
 const execution={status:async()=>null,apply:async()=>{},inspect:async(release)=>{if(!rollback&&release.version==='1.3.0')throw new Error('Synthetic preparation failure');},referencedRoots:async()=>[]};
 const post=(action,input={})=>fetch(base+'/__opencraft_updates/'+action,{method:'POST',headers:{origin:base,cookie,'content-type':'application/json'},body:JSON.stringify(input)});
 const status=async()=>await(await fetch(base+'/__opencraft_updates',{headers:{cookie}})).json();
 async function until(predicate){const end=Date.now()+10000;while(Date.now()<end){const value=await status();if(predicate(value))return value;await new Promise(r=>setTimeout(r,20));}throw new Error('Managed test timed out');}
 async function open(){cookie='';app=await createManagedWebServer({initialRelease:packages['1.1.0'].packageRoot,stateDirectory,source,execution});base='http://127.0.0.1:'+(await app.listen({port:0})).port;const key=(await readFile(app.adminKeyPath,'utf8')).trim();const login=await post('login',{key});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];}
 async function install(version,phase){selected=version;if(!rollback){assert.equal((await post('install-local',packages[version])).status,202);}else{assert.equal((await post('check')).status,202);await until(s=>!s.checking&&s.latest?.version===version);assert.equal((await post('install',{version})).status,202);}return until(s=>s.job?.phase===phase);}
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
console.log(JSON.stringify({preparationFailure:await run('prepare',false),rollbackThenWorkerFailure:await run('rollback',true)}));`;
  const path=join(root,'scenario.mjs');await writeFile(path,scenario);
  const {stdout}=await promisify(execFile)(process.execPath,[path,root],{timeout:45000,maxBuffer:1024*1024,env:{...process.env,OPENCRAFT_FULL_RELEASE_TRUST_JSON:JSON.stringify(trust),OPENCRAFT_NPM_PACKAGE_NAME:trust.packageName}});
  assert.deepEqual(JSON.parse(stdout.trim()),{preparationFailure:{current:'1.1.0',highest:3},rollbackThenWorkerFailure:{current:'1.1.0',highest:3}});
});

test('complete tree components remain consumable by the fixed bridge contract and match final dry-run',async t=>{
 const root=await mkdtemp(join(tmpdir(),'full-release-components-'));t.after(()=>rm(root,{recursive:true,force:true}));const pkg=join(root,'package'),key=join(root,'key.pem');
 for(const dir of ['web','runtime','execution','node_modules/library','full/core','full/codex','full/dsh','release']){await mkdir(join(pkg,dir),{recursive:true});await writeFile(join(pkg,dir,'LICENSE'),'MIT');}
 await writeFile(key,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
 await writeFile(join(pkg,'package.json'),JSON.stringify({name:trust.packageName,version:'1.0.0',license:'MIT',files:['web','runtime','execution','full','release'],opencraftWeb:{schemaVersion:1,workerProtocol:1,buildId:'fixture'}}));await writeFile(join(pkg,'LICENSE'),'MIT');await writeFile(join(pkg,'README.md'),'Deployment');await writeFile(join(pkg,'runtime/main.mjs'),'code');await writeFile(join(pkg,'web/version.json'),JSON.stringify({sourceRevision:source,buildId:'fixture'}));
 const template=fixture();template.updater.bridge=false;const packed=await sealPackage({packageRoot:pkg,directory:root,template,keyPath:key,keyId}),checked=await verifyFullArchive(join(root,packed.filename),trust);
 assert.ok(checked.record.components.some(c=>c.role==='core'));assert.ok(checked.record.components.some(c=>c.role==='cli'));assert.ok(checked.record.components.some(c=>c.role==='dsh'));assert.equal(packed.fullRelease.dryRun.integrity,packed.integrity);assert.equal(packed.fullRelease.dryRun.entries,checked.entries);assert.match(await readFile(join(pkg,'README.md'),'utf8'),/SPDX-License-Identifier: Apache-2.0/);
});
