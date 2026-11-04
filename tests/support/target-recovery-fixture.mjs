import { mkdtemp, mkdir, readFile, writeFile, chmod, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signedInspectionFixture } from './full-upgrade-fixture.mjs';
import { sha256 } from '../../scripts/full-release/contract.mjs';
export async function targetRecoveryFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'recover-target-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = '89eed8a6-6d26-49c8-a11c-3bf9d89a98e1';
  const webState = join(root, 'web');
  const config = { targetRoot: join(webState, 'releases', id, 'package'), webState,
    trustFile: join(root, 'trust.json'), profilePath: join(root, 'profile.json') };
  await signedInspectionFixture(config);
  await writeFile(join(config.targetRoot, 'LICENSE'), 'license');
  await chmod(join(config.targetRoot, 'LICENSE'), 0o644);
  await chmod(join(config.targetRoot, 'release/upgrade-policy.json'), 0o644);
  await mkdir(join(config.targetRoot, 'runtime')); await mkdir(join(config.targetRoot, 'web'));
  const worker = version => `import {createServer} from 'node:http';const s=createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify(q.url==='/version.json'?{buildId:'fixture${version}'}:{ok:true}));});s.listen(0,'127.0.0.1',()=>process.send({protocol:1,version:'${version}.0.0',buildId:'fixture${version}',port:s.address().port}));`;
  await writeFile(join(config.targetRoot, 'package.json'), JSON.stringify({ name: '@opencraft-app/opencraft', version: '2.0.0', opencraftWeb: { schemaVersion: 1, workerProtocol: 1, buildId: 'fixture2' } }));
  await writeFile(join(config.targetRoot, 'runtime/worker.mjs'), worker(2));
  await writeFile(join(config.targetRoot, 'web/version.json'), JSON.stringify({ buildId: 'fixture2' }));
  await writeFile(join(config.targetRoot, 'web/index.html'), '<meta content="fixture2">');
  const currentRoot = join(root, 'current'); await cp(config.targetRoot, currentRoot, { recursive: true });
  await writeFile(join(currentRoot, 'package.json'), JSON.stringify({ name: '@opencraft-app/opencraft', version: '1.0.0', opencraftWeb: { schemaVersion: 1, workerProtocol: 1, buildId: 'fixture1' } }));
  await writeFile(join(currentRoot, 'runtime/worker.mjs'), worker(1));
  await writeFile(join(currentRoot, 'web/version.json'), JSON.stringify({ buildId: 'fixture1' }));
  await writeFile(join(currentRoot, 'web/index.html'), '<meta content="fixture1">');
  const manifestSha256 = sha256(await readFile(join(config.targetRoot, 'release/full-release.json')));
  const current = { releaseRoot: currentRoot, version: '1.0.0', buildId: 'fixture1', fullRelease: { manifestSha256, releaseId: 'fixture-release', releaseSequence: 1, authorization: 'verified-installation' } };
  const child = { schemaVersion: 1, id, version: '2.0.0', buildId: 'fixture2', phase: 'recovery-required', manifestSha256, releaseId: 'fixture-release', retainedRoot: config.targetRoot, startedAt: new Date().toISOString() };
  const persisted = { schemaVersion: 1, current, previous: null, job: { id, version: child.version, phase: 'failed', error: 'original failed installation' } };
  const childPath = join(webState, 'upgrade-children', id + '.json');
  await mkdir(join(webState, 'upgrade-children')); await writeFile(childPath, JSON.stringify(child));
  await writeFile(join(webState, 'deployment.json'), JSON.stringify(persisted));
  const input = { jobId: id, version: child.version, buildId: child.buildId, manifestSha256 };
  const trust = JSON.parse(await readFile(config.trustFile, 'utf8'));
  return { root, config, child, childPath, persisted, input, trust,
    args: { directory: webState, persisted, input, trust, upgrade: async () => ({ allowed: true }), active: () => true } };
}
