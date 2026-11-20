import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const imageId = /^sha256:[a-f0-9]{64}$/;
const repositoryName = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]+)?(?:\/[a-z0-9][a-z0-9._-]*)+$/;
const services = ['gateway', 'brain', 'hands', 'proxy'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
function save(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}
function docker(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8', timeout: args[0] === 'push' ? 2_700_000 : 120_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', args[0] === 'push' ? 'inherit' : 'pipe', 'inherit'],
  });
}

export function collectReleases(releases, since) {
  assert.ok(Number.isFinite(Date.parse(since)), 'Expected an explicit upload start time');
  const selected = [];
  for (const entry of readdirSync(releases, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(releases, entry.name);
    if (!existsSync(join(directory, 'receipt.json'))) continue;
    const receipt = read(join(directory, 'receipt.json'));
    if (receipt.phase !== 'succeeded' || Date.parse(receipt.updatedAt) < Date.parse(since)) continue;
    assert.ok(Number.isFinite(Date.parse(receipt.updatedAt)), `Invalid receipt time: ${entry.name}`);
    const bytes = readFileSync(join(directory, 'plan.json'));
    const plan = JSON.parse(bytes);
    assert.equal(plan.schemaVersion, 1);
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(hash(bytes), receipt.planSha256, `Release plan changed: ${entry.name}`);
    assert.equal(plan.releaseId, entry.name);
    assert.equal(receipt.releaseId, plan.releaseId);
    assert.equal(receipt.sourceRevision, plan.sourceRevision);
    assert.match(plan.sourceRevision, /^[a-f0-9]{40,64}$/);
    assert.equal(receipt.candidateImageId, plan.candidateImageId);
    assert.match(plan.candidateImageId, imageId);
    assert.ok(services.includes(plan.service), 'Unsupported release service');
    // The release verifier guarantees that the other services retain their baseline images.
    // Use the recorded deployment, not whatever happens to be live when this task runs.
    const images = Object.fromEntries(services.map(service => {
      const id = service === plan.service ? plan.candidateImageId : plan.expectedImages?.[service];
      assert.match(id || '', imageId, `Missing snapshot image for ${service}: ${entry.name}`);
      return [service, id];
    }));
    selected.push({ directory, plan, receipt, images });
  }
  return selected.sort((a, b) => Date.parse(a.receipt.updatedAt) - Date.parse(b.receipt.updatedAt));
}

function verifyRemote(ref, expectedImage, platform, run, repository) {
  let manifest = JSON.parse(run(['buildx', 'imagetools', 'inspect', '--raw', ref]));
  if (manifest.manifests) {
    const descriptor = manifest.manifests.find(item => item.platform?.os === platform.Os
      && item.platform?.architecture === platform.Architecture);
    assert.ok(descriptor, 'Remote image has no matching platform');
    assert.match(descriptor.digest, imageId);
    manifest = JSON.parse(run(['buildx', 'imagetools', 'inspect', '--raw', `${repository}@${descriptor.digest}`]));
  }
  assert.equal(manifest.config?.digest, expectedImage, 'Remote image differs from the released image');
}

function publishImage(service, id, state, run, repository) {
  const key = `${service}-${id.slice(7)}`;
  const cacheFile = join(state, 'images', `${key}.json`);
  if (existsSync(cacheFile)) {
    const cached = read(cacheFile);
    assert.equal(cached.imageId, id);
    assert.ok(cached.ref.startsWith(`${repository}@`), 'Cached image belongs to another repository');
    assert.match(cached.ref.slice(repository.length + 1), imageId);
    verifyRemote(cached.ref, id, cached.platform, run, repository);
    return cached;
  }
  const [image] = JSON.parse(run(['image', 'inspect', id]));
  assert.equal(image.Id, id);
  assert.equal(image.Os, 'linux');
  const tag = `${repository}:fast-${key}`;
  console.log(`Uploading ${service}: ${id}`);
  run(['tag', id, tag]);
  run(['push', tag]);
  const [pushed] = JSON.parse(run(['image', 'inspect', tag]));
  assert.equal(pushed.Id, id);
  const ref = pushed.RepoDigests.find(item => item.startsWith(`${repository}@`));
  assert.ok(ref, 'Push did not record a registry digest');
  assert.match(ref.slice(repository.length + 1), imageId);
  verifyRemote(ref, id, image, run, repository);
  const result = { imageId: id, platform: { Os: image.Os, Architecture: image.Architecture }, tag, ref };
  save(cacheFile, result);
  return result;
}

export function uploadReleases({ releases, state, since, repository, dryRun = false, run = docker }) {
  assert.equal(typeof repository, 'string', 'An explicit destination repository is required');
  assert.match(repository, repositoryName, 'Expected an untagged registry repository');
  const queue = collectReleases(releases, since);
  if (dryRun) return queue.map(({ plan, images }) => ({ releaseId: plan.releaseId, service: plan.service, image: plan.candidateImageId, images }));
  mkdirSync(join(state, 'releases'), { recursive: true, mode: 0o700 });
  mkdirSync(join(state, 'images'), { recursive: true, mode: 0o700 });
  let uploaded = 0;
  for (const { directory, plan, receipt, images } of queue) {
    const resultFile = join(state, 'releases', `${plan.releaseId}.json`);
    const previous = existsSync(resultFile) ? read(resultFile) : {};
    if (previous.phase === 'uploaded' && previous.planSha256 === receipt.planSha256
      && services.every(service => previous.images?.[service]?.imageId === images[service]
        && previous.images[service].ref?.startsWith(`${repository}@`)
        && imageId.test(previous.images[service].ref.slice(repository.length + 1)))) continue;
    // A rollback may have happened after collecting the queue.
    if (read(join(directory, 'receipt.json')).phase !== 'succeeded') continue;
    const result = {
      schemaVersion: 2, releaseId: plan.releaseId, sourceRevision: plan.sourceRevision,
      planSha256: receipt.planSha256, imageId: plan.candidateImageId, service: plan.service,
      images: {}, phase: 'uploading', attempts: (previous.attempts || 0) + 1, updatedAt: new Date().toISOString(),
    };
    save(resultFile, result);
    try {
      for (const service of services) {
        result.uploadingService = service;
        save(resultFile, result);
        result.images[service] = publishImage(service, images[service], state, run, repository);
        result.updatedAt = new Date().toISOString();
        save(resultFile, result);
      }
      delete result.uploadingService;
      // Retain the original changed-service fields for existing receipt consumers.
      result.tag = result.images[plan.service].tag;
      result.ref = result.images[plan.service].ref;
      save(resultFile, { ...result, phase: 'uploaded', updatedAt: new Date().toISOString() });
      console.log(`Uploaded ${plan.releaseId}: complete four-service snapshot`);
      uploaded++;
    } catch (error) {
      save(resultFile, { ...result, phase: 'failed', error: error.message, updatedAt: new Date().toISOString() });
      throw error;
    }
  }
  return { eligible: queue.length, uploaded };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [releases, state, since, repository, mode] = process.argv.slice(2);
  assert.ok(releases && state && since && repository && (!mode || mode === '--dry-run'),
    'Usage: upload-fast-releases.mjs RELEASE_STATE UPLOAD_STATE SINCE_ISO REGISTRY_REPOSITORY [--dry-run]');
  try {
    console.log(JSON.stringify(uploadReleases({ releases, state, since, repository, dryRun: mode === '--dry-run' })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
