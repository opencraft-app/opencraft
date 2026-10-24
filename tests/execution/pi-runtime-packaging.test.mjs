import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { copyPiRuntime } from '../../scripts/package-mcp-app-runtime.mjs';

test('packaged Pi dependencies resolve in isolation and keep all symlinks inside the archive', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-packaged-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const versions = await copyPiRuntime(join(directory, 'node_modules'));
  assert.ok(Object.values(versions).every(version => version === '1.3.0'));
  async function inspect(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        const target = relative(directory, await realpath(file));
        assert.ok(!isAbsolute(target) && target !== '..' && !target.startsWith('../'), `Escaping runtime link: ${file}`);
      } else if (entry.isDirectory()) await inspect(file);
    }
  }
  await inspect(directory);
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    'import {Harness} from "@earendil-works/pi-durable"; import {ModelRuntime} from "@earendil-works/pi-coding-agent"; console.log(typeof Harness.open, typeof ModelRuntime.create);'],
    { cwd: directory, env: { ...process.env, NODE_PATH: '' } });
  assert.equal(stdout.trim(), 'function function');
});
