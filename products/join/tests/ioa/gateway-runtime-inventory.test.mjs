import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, symlink, truncate, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectGatewayRuntime } from '../../tools/inspect-gateway-runtime.mjs';
const launcher = gateway => `const entries = { brain: "native-host.mjs", hands: "native-hands.mjs", gateway: '${gateway}' };`;
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-inventory-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'container-service.mjs'), launcher('container-gateway.account-defaults.mjs'));
  await writeFile(join(dir, 'container-gateway.mjs'), 'throw Error("retained module must never execute")');
  await writeFile(join(dir, 'container-gateway.account-defaults.mjs'), 'throw Error("selected module must never execute")');
  return dir;
}
test('inventory follows launcher selection, not an inert old bind; never imports code or changes bytes', async t => {
  const dir = await fixture(t), before = await readFile(join(dir, 'container-gateway.account-defaults.mjs'));
  await writeFile(join(dir, 'join-credential-loader.mjs'), 'throw Error("loader must never execute")');
  const result = await inspectGatewayRuntime(dir);
  assert.equal(result.readOnly, true);
  assert.equal(result.selectedGateway.name, 'container-gateway.account-defaults.mjs');
  assert.equal(result.selectedGateway.sha256, hash(before));
  assert.equal(result.retainedGatewayIsSelected, false);
  assert.notEqual(result.retainedGateway.sha256, result.selectedGateway.sha256);
  assert.equal(result.compatibilityLoaderPresent.name, 'join-credential-loader.mjs');
  assert.deepEqual(await readFile(join(dir, 'container-gateway.account-defaults.mjs')), before);
});
test('standard launcher needs neither legacy module nor credential loader', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'container-service.mjs'), launcher('container-gateway.mjs'));
  const result = await inspectGatewayRuntime(dir);
  assert.equal(result.retainedGatewayIsSelected, true);
  assert.deepEqual(result.retainedGateway, result.selectedGateway);
  assert.equal(result.compatibilityLoaderPresent, null);
});
test('unknown, ambiguous or traversing launcher selection is rejected instead of guessed', async t => {
  const dir = await fixture(t);
  for (const value of ['const entries = dynamicEntries;', launcher('../outside.mjs'), launcher('container-gateway.mjs').replace(' };', ', gateway: dynamicEntry };'), launcher('container-gateway.mjs') + launcher('container-gateway.account-defaults.mjs')]) {
    await writeFile(join(dir, 'container-service.mjs'), value);
    await assert.rejects(inspectGatewayRuntime(dir));
  }
  await assert.rejects(inspectGatewayRuntime('.'));
  await assert.rejects(inspectGatewayRuntime('/'));
});
test('symlinked, absent and oversized selected artifacts are rejected without fallback', async t => {
  const dir = await fixture(t), selected = join(dir, 'container-gateway.account-defaults.mjs');
  await rm(selected);await assert.rejects(inspectGatewayRuntime(dir));
  await symlink('container-gateway.mjs', selected);await assert.rejects(inspectGatewayRuntime(dir));
  await rm(selected);await writeFile(selected, '');await truncate(selected, 32 * 1024 * 1024 + 1);await assert.rejects(inspectGatewayRuntime(dir));
});

test('CLI works through a symlinked path and prints a read-only inventory', async t => {
  const dir = await fixture(t), alias = join(dir, 'inspect-alias.mjs');
  await symlink(fileURLToPath(new URL('../../tools/inspect-gateway-runtime.mjs', import.meta.url)), alias);
  const stdout = execFileSync(process.execPath, [alias, dir], { encoding: 'utf8' });
  assert.equal(JSON.parse(stdout).selectedGateway.name, 'container-gateway.account-defaults.mjs');
});

test('current four-role launcher with proxy is supported alongside the retained three-role launcher', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'container-service.mjs'), launcher('container-gateway.mjs').replace(' };', ", proxy: 'proxy-host.mjs' };"));
  assert.equal((await inspectGatewayRuntime(dir)).selectedGateway.name, 'container-gateway.mjs');
});
