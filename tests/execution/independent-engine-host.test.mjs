import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startIndependentEngineHost } from '../../scripts/server-deployment/engine-host.mjs';
import { attachEngineHost } from '../../scripts/server-deployment/engine-host-client.mjs';
import { ModelConfigurationRepository } from '../../apps/local-agent-host/src/model-config/repository.ts';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'independent-engine-host-test-'));
  const options = {
    dataDirectory: join(root, 'data'),
    descriptorPath: join(root, 'host.json'),
    runtimeDirectory: root,
    engines: ['pi'],
    defaultEngine: 'pi',
  };
  await new ModelConfigurationRepository(join(options.dataDirectory, 'models')).initialize({
    schemaVersion: 1,
    revision: 0,
    providers: [],
    defaultModel: null,
  });
  const host = await startIndependentEngineHost(options);
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  const descriptor = JSON.parse(await readFile(options.descriptorPath, 'utf8'));
  const attach = () =>
    attachEngineHost(options.descriptorPath, options.dataDirectory, descriptor.machineId, ['pi'], 'pi');
  return { root, options, host, descriptor, attach };
}

test('gateway attachment close leaves the independent execution owner available', async (t) => {
  const f = await fixture(t);
  const client = await f.attach();
  assert.equal((await client.getIdentity()).pid, process.pid);
  assert.equal((await client.getExecutionIdentity("pi_fixture")).pid,process.pid);
  await assert.rejects(client.getExecutionIdentity("acp_unknown"));
  await client.close();
  assert.equal((await (await f.attach()).getIdentity()).pid, process.pid);
  await assert.rejects(startIndependentEngineHost(f.options), /already being held/);
  assert.equal((await f.attach()).websocketUrl, client.websocketUrl);
  await f.host.close();
  await assert.rejects(f.attach(), /ENOENT/);
});

test('private descriptor validates directory, machine, engine selection and live health', async (t) => {
  const f = await fixture(t);
  for (const args of [
    [join(f.root, 'other'), f.descriptor.machineId, ['pi'], 'pi'],
    [f.options.dataDirectory, 'foreign-machine', ['pi'], 'pi'],
    [f.options.dataDirectory, f.descriptor.machineId, ['dsh', 'pi'], 'pi'],
    [f.options.dataDirectory, f.descriptor.machineId, ['pi'], 'dsh'],
  ])
    await assert.rejects(attachEngineHost(f.options.descriptorPath, ...args), /incompatible/);
  await chmod(f.options.descriptorPath, 0o644);
  await assert.rejects(f.attach(), /private/);
  await chmod(f.options.descriptorPath, 0o600);
  await writeFile(f.options.descriptorPath, JSON.stringify({ ...f.descriptor, token: 'wrong' }), { mode: 0o600 });
  await assert.rejects(f.attach());
  await writeFile(f.options.descriptorPath, JSON.stringify(f.descriptor), { mode: 0o600 });
  const health = await fetch(new URL('/health', f.descriptor.controlUrl), {
    headers: { origin: 'http://untrusted.invalid', authorization: 'Bearer ' + f.descriptor.token },
  });
  assert.equal(health.status, 403);
  const input = await fetch(new URL('/host-inputs', f.descriptor.controlUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(input.status, 403);
});
