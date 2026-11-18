import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadUserPlugins, userPluginAsset } from '../../scripts/web-deployment/user-plugins.mjs';

const example = fileURLToPath(new URL('../../examples/user-plugins/', import.meta.url));

test('the bundled user-plugin example loads with its published identity and registers its command', async () => {
  const plugins = await loadUserPlugins(example);
  assert.equal(plugins.length, 1);
  const [entry] = plugins;
  assert.equal(entry.manifest.id, 'user.hello');
  const path = await userPluginAsset(example, entry.entry);
  const plugin = (await import(pathToFileURL(path).href)).default;
  assert.deepEqual(plugin.manifest, entry.manifest);
  const commands = [];
  await plugin.activate({ commands: { register: (metadata, run) => commands.push({ metadata, run }) } });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].metadata.id, 'user.hello.greet');
  assert.equal(commands[0].run(), 'Hello');
});

test('editing the example without updating its integrity digest is rejected', async t => {
  const root = await mkdtemp(join(tmpdir(), 'opencraft-user-example-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(example, root, { recursive: true });
  const entry = join(root, 'public/user.hello/plugin.mjs');
  await writeFile(entry, (await readFile(entry, 'utf8')) + '\n// changed\n');
  await assert.rejects(loadUserPlugins(root), /integrity mismatch/);
});
