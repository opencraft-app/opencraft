import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { bundleCodexCore } from '../../scripts/full-release/core-programs.mjs';

const execute = promisify(execFile);
test('independently packaged Core can read fault custody after controller replacement without source dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oc-packaged-core-'));
  const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const directory = join(root, 'package/full/core');
  try {
    await bundleCodexCore({ repositoryRoot, directory });
    const probe = join(directory, 'recovery-probe.cjs');
    await build({ absWorkingDir: repositoryRoot, stdin: { resolveDir: repositoryRoot, contents: `
      import { CodexGenerationRegistry } from './apps/codex-core/src/generation-registry.ts';
      import { readRouterRecoveryEvidence } from './apps/codex-core/src/router-recovery-evidence.ts';
      (async () => {
        const directory = process.argv[2], registry = new CodexGenerationRegistry(directory);
        registry.setMetadata('router-uncertainty:fixture', {generationId:'one', incarnation:1});
        registry.setMetadata('private-account-not-part-of-recovery', 'excluded'); registry.close();
        console.log(JSON.stringify(await readRouterRecoveryEvidence(directory)));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    ` }, outfile: probe, bundle: true, platform: 'node', format: 'cjs', target: 'node26', logLevel: 'silent' });
    const { stdout } = await execute(process.execPath, [probe, join(root, 'registry')], {cwd: root, timeout: 15000});
    assert.deepEqual(JSON.parse(stdout), [{key:'router-uncertainty:fixture', value:{generationId:'one', incarnation:1}}]);
  } finally { await rm(root, {recursive:true, force:true}); }
});
