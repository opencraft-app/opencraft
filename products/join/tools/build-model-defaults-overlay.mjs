import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { modelDefaultsOverlay, retainCredentialCompatibility, modelDefaultsServiceEntry, modelPolicySelectionOverlay } from './model-defaults-overlay.mjs';
import { verifyWorkspaceBindings } from '../build-workspace-guard.mjs';
const [input, output, expectedSha256, sourceRevision, loaderPath, loaderSha256, launcherPath, launcherSha256] = process.argv.slice(2);
if (!input || !output || !/^[a-f0-9]{40}$/.test(sourceRevision ?? '')) throw Error('Usage: build-model-defaults-overlay INPUT OUTPUT_DIRECTORY EXPECTED_SHA256 SOURCE_COMMIT');
const product = resolve(dirname(fileURLToPath(import.meta.url)), '..');
verifyWorkspaceBindings(resolve(product, '../..'));
await mkdir(resolve(output), { recursive: true });
const rawSource = await readFile(resolve(input), 'utf8');
if (createHash('sha256').update(rawSource).digest('hex') !== expectedSha256) throw Error('Gateway baseline digest changed');
const source = modelPolicySelectionOverlay(loaderPath ? retainCredentialCompatibility(rawSource, await readFile(loaderPath, 'utf8'), loaderSha256) : rawSource);
const transformedSha256 = createHash('sha256').update(source).digest('hex');
const gateway = resolve(output, 'container-gateway.account-defaults.mjs');
await writeFile(gateway, modelDefaultsOverlay(source, transformedSha256));
if (launcherPath) await writeFile(resolve(output, 'container-service.mjs'), modelDefaultsServiceEntry(await readFile(launcherPath, 'utf8'), launcherSha256));
const adapter = resolve(output, 'account-model-defaults.mjs');
await build({ entryPoints: [resolve(product, 'plugins/tencentoa/src/model-defaults-composition.mjs')], outfile: adapter,
  bundle: true, platform: 'node', format: 'esm', target: 'node26',
  banner: { js: "import {createRequire as __accountRequire} from 'node:module';const require=__accountRequire(import.meta.url);" },
});
for (const file of [gateway, adapter, ...(launcherPath ? [resolve(output, 'container-service.mjs')] : [])]) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) throw Error('Invalid candidate runtime');
}
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');
await writeFile(resolve(output, 'account-model-defaults-receipt.json'), JSON.stringify({schemaVersion:1,sourceRevision,
  baselineGatewaySha256:expectedSha256,retainedLoaderSha256:loaderSha256,baselineLauncherSha256:launcherSha256,gatewaySha256:await sha(gateway),adapterSha256:await sha(adapter),
  scope:'Account defaults composition only; retained baseline platform and database migrations'},null,2)+'\n');
console.log(JSON.stringify({ok:true,output:resolve(output),sourceRevision}));
