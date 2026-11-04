import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readDshColdResources } from '../../scripts/server-deployment/dsh-cold-resources.mjs';
import { DshOwnerHandoff } from '../../scripts/server-deployment/dsh-owner-handoff.mjs';

test('GC after declaration preserves handoff and old-owner recovery with pinned skill content', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cold-dependencies-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = join(root, 'releases/old'), pin = join(root, 'content/skill-digest');
  const skills = join(root, 'skills');
  for (const path of [release, pin, skills, join(root, 'owner-handoff')]) await mkdir(path, { recursive: true });
  await writeFile(join(pin, 'SKILL.md'), 'pinned skill');
  await symlink(pin, join(skills, 'managed'));
  // Previous configs may retain an unused release declaration. Proof reads
  // the actual pinned link, never an unrelated retired release.
  const resources = { dependencyRoots: [release, pin], skills };
  const before = await readDshColdResources(resources);
  const host = {
    engineProcessId: process.pid,
    nativeOwner: async () => ({ pid: process.pid, owner: 'native', configuration: 'fixed', coverage: 'complete', activeCount: 0, records: [] }),
    handoffObservation: async () => ({ coverage: 'complete', activeCount: 0 }),
    coldReadResources: () => readDshColdResources(resources), close: async () => {}, resumeBackground: () => {},
  };
  const make = async () => {
    const owner = new DshOwnerHandoff(root, { version: 'old' }, () => ({ coverage: 'complete', activeCount: 0 }));
    await owner.load(); owner.attach(host); return owner;
  };
  const expected = (owner: any) => ({ expectedOwner: owner.authority.owner, expectedEpoch: owner.authority.snapshot().epoch, operationId: 'gc', fence: 'gc' });
  let owner = await make();
  await owner.control('fence', expected(owner)); await owner.control('release', expected(owner));
  await rm(release, { recursive: true });
  assert.deepEqual(await readDshColdResources(resources), before);
  owner = await make();
  let ready = await owner.control('cold-ready', expected(owner));
  await owner.control('resume', { ...expected(owner), identity: ready.handoff.ready.identity });
  assert.equal(owner.open(), true);
  await owner.control('fence', expected(owner)); await owner.control('release', expected(owner));
  // Candidate fails after cold-ready. The previous code/config acquires a
  // fresh proof against current data; no snapshot is restored.
  const candidate = await make();
  await candidate.control('cold-ready', expected(candidate));
  owner = await make();
  ready = await owner.control('cold-ready', expected(owner));
  await owner.control('resume', { ...expected(owner), identity: ready.handoff.ready.identity });
  assert.equal(owner.open(), true);
  assert.deepEqual(await readDshColdResources(resources), before);
});

test('missing live targets and links outside declarations still reject cold proof', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cold-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skills = join(root, 'skills'), external = join(root, 'external');
  await mkdir(skills); await mkdir(external);
  await writeFile(join(external, 'SKILL.md'), 'external');
  await symlink(external, join(skills, 'managed'));
  await assert.rejects(readDshColdResources({ skills, dependencyRoots: [join(root, 'expired')] }), /Unbound/);
  await rm(external, { recursive: true });
  await assert.rejects(readDshColdResources({ skills, dependencyRoots: [external] }), { code: 'ENOENT' });
});
