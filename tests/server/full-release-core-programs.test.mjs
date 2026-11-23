import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleCodexCore } from '../../scripts/full-release/core-programs.mjs';

test('independently packaged Core ships only the account Core and APP server programs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oc-packaged-core-'));
  const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const directory = join(root, 'package/full/core');
  try {
    await bundleCodexCore({ repositoryRoot, directory });
    assert.deepEqual((await readdir(directory)).sort(), ['app-server.cjs', 'main.cjs']);
    for (const name of ['app-server.cjs', 'main.cjs']) {
      assert.doesNotMatch(await readFile(join(directory, name), 'utf8'), /generation-registry-worker|router-evidence-worker/u);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
