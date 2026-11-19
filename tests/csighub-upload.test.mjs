import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { uploadReleases } from '../scripts/ci/upload-fast-releases.mjs';

const image = `sha256:${'a'.repeat(64)}`;
const ref = `csighub.tencentyun.com/join/opencraft@sha256:${'b'.repeat(64)}`;
const images = { gateway: image, brain: `sha256:${'c'.repeat(64)}`, hands: `sha256:${'e'.repeat(64)}`, proxy: `sha256:${'f'.repeat(64)}` };
const refs = Object.fromEntries(Object.entries(images).map(([service, id]) => [service,
  service === 'gateway' ? ref : `csighub.tencentyun.com/join/opencraft@${id}`]));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'csighub-upload-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const releases = join(root, 'deployments'), state = join(root, 'uploads');
  mkdirSync(releases);
  const calls = [];
  let pushFailure = false, wrongRemote = false;
  const tags = {};
  const run = args => {
    calls.push(args);
    if (args[0] === 'push' && (pushFailure === true || args[1].includes(`fast-${pushFailure}-`))) throw new Error('registry unavailable');
    if (args[0] === 'tag') tags[args[2]] = args[1];
    if (args[0] === 'image') {
      const id = tags[args[2]] || args[2], service = Object.keys(images).find(service => images[service] === id);
      assert.ok(service);
      return JSON.stringify([{ Id: id, Os: 'linux', Architecture: 'amd64', RepoDigests: [refs[service]] }]);
    }
    if (args[0] === 'buildx') {
      const service = Object.keys(refs).find(service => refs[service] === args.at(-1));
      assert.ok(service);
      return JSON.stringify({ config: { digest: wrongRemote ? `sha256:${'0'.repeat(64)}` : images[service] } });
    }
    assert.ok(['tag', 'push'].includes(args[0]), `Unexpected Docker operation: ${args}`);
    return '';
  };
  function release(id, phase = 'succeeded', updatedAt = '2026-11-15T14:00:00Z') {
    const directory = join(releases, id);
    mkdirSync(directory);
    const plan = { schemaVersion: 1, releaseId: id, service: 'gateway', sourceRevision: 'd'.repeat(40), candidateImageId: image,
      expectedImages: { ...images, gateway: `sha256:${'1'.repeat(64)}` } };
    const bytes = JSON.stringify(plan);
    const receipt = { ...plan, planSha256: createHash('sha256').update(bytes).digest('hex'), phase, updatedAt };
    writeFileSync(join(directory, 'plan.json'), bytes);
    writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt));
    return directory;
  }
  return { root, releases, state, calls, release, fail: value => { pushFailure = value; }, wrongRemote: () => { wrongRemote = true; },
    upload: (extra = {}) => uploadReleases({ releases, state, since: '2026-11-15T13:00:00Z', run, ...extra }),
    result: id => JSON.parse(readFileSync(join(state, 'releases', `${id}.json`), 'utf8')) };
}

test('uploads only successful eligible releases, records immutable identity, and does not repeat pushes', t => {
  const f = fixture(t);
  f.release('current'); f.release('old', 'succeeded', '2026-11-14T14:00:00Z');
  f.release('failed', 'rolled_back'); f.release('running', 'applying');
  assert.deepEqual(f.upload(), { eligible: 1, uploaded: 1 });
  assert.equal(f.result('current').ref, ref);
  assert.equal(f.result('current').imageId, image);
  assert.equal(f.result('current').phase, 'uploaded');
  assert.deepEqual(Object.fromEntries(Object.entries(f.result('current').images).map(([service, item]) => [service, item.imageId])), images);
  assert.equal(f.calls.filter(args => args[0] === 'push').length, 4);
  const count = f.calls.length;
  assert.deepEqual(f.upload(), { eligible: 1, uploaded: 0 });
  assert.equal(f.calls.length, count);
});

test('a push failure keeps a retryable receipt without altering deployment records', t => {
  const f = fixture(t), directory = f.release('retry');
  const before = readFileSync(join(directory, 'receipt.json'), 'utf8');
  f.fail(true);
  assert.throws(() => f.upload(), /registry unavailable/);
  assert.equal(f.result('retry').phase, 'failed');
  f.fail(false); f.upload();
  assert.equal(f.result('retry').phase, 'uploaded');
  assert.equal(f.result('retry').attempts, 2);
  assert.equal(readFileSync(join(directory, 'receipt.json'), 'utf8'), before);
});

test('refuses modified release plans before any Docker operation', t => {
  const f = fixture(t), directory = f.release('tampered');
  writeFileSync(join(directory, 'plan.json'), '{}');
  assert.throws(() => f.upload());
  assert.equal(f.calls.length, 0);
});

test('a successful push is not accepted when the remote config differs', t => {
  const f = fixture(t); f.release('mismatch'); f.wrongRemote();
  assert.throws(() => f.upload(), /Remote image differs/);
  assert.equal(f.result('mismatch').phase, 'failed');
});

test('two releases of the same image reuse a verified registry ref', t => {
  const f = fixture(t); f.release('one'); f.release('two');
  assert.equal(f.upload().uploaded, 2);
  assert.equal(f.calls.filter(args => args[0] === 'push').length, 4);
  assert.equal(f.calls.filter(args => args[0] === 'buildx').length, 8);
  assert.equal(f.result('one').ref, f.result('two').ref);
});

test('dry run lists the queue without creating state or invoking Docker', t => {
  const f = fixture(t); f.release('preview');
  assert.deepEqual(f.upload({ dryRun: true }), [{ releaseId: 'preview', service: 'gateway', image, images }]);
  assert.equal(f.calls.length, 0);
  assert.equal(existsSync(f.state), false);
});

test('a partial snapshot retries only missing images and never marks three images as complete', t => {
  const f = fixture(t); f.release('partial'); f.fail('proxy');
  assert.throws(() => f.upload(), /registry unavailable/);
  assert.equal(f.result('partial').phase, 'failed');
  assert.equal(f.result('partial').uploadingService, 'proxy');
  assert.equal(Object.keys(f.result('partial').images).length, 3);
  f.fail(false); f.upload();
  assert.equal(f.result('partial').phase, 'uploaded');
  assert.equal(Object.keys(f.result('partial').images).length, 4);
  assert.equal(f.calls.filter(args => args[0] === 'push').length, 5);
});

test('old single-service success receipts are upgraded to complete snapshots', t => {
  const f = fixture(t); f.release('legacy'); f.upload();
  const result = f.result('legacy');
  delete result.images;
  writeFileSync(join(f.state, 'releases', 'legacy.json'), JSON.stringify(result));
  const count = f.calls.filter(args => args[0] === 'push').length;
  assert.equal(f.upload().uploaded, 1);
  assert.equal(Object.keys(f.result('legacy').images).length, 4);
  assert.equal(f.calls.filter(args => args[0] === 'push').length, count);
});

test('incomplete release baselines cannot be uploaded as four-service snapshots', t => {
  const f = fixture(t), directory = f.release('missing');
  const plan = JSON.parse(readFileSync(join(directory, 'plan.json')));
  delete plan.expectedImages.proxy;
  const bytes = JSON.stringify(plan);
  const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json')));
  receipt.planSha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(directory, 'plan.json'), bytes);
  writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt));
  assert.throws(() => f.upload(), /Missing snapshot image for proxy/);
  assert.equal(f.calls.length, 0);
});

test('CLI dry run also executes when launched through a symlink', t => {
  const f = fixture(t); f.release('cli');
  const link = join(f.root, 'upload.mjs');
  symlinkSync(new URL('../scripts/ci/upload-fast-releases.mjs', import.meta.url), link);
  const output = execFileSync(process.execPath, [link, f.releases, f.state, '2026-11-15T13:00:00Z', '--dry-run'], { encoding: 'utf8' });
  assert.equal(JSON.parse(output)[0].releaseId, 'cli');
  assert.equal(existsSync(f.state), false);
});
