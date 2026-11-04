import { build } from 'esbuild';
import { readFile, writeFile, mkdir, cp, readdir, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { copyDependencyClosure } from './closure.mjs';
import { cachedRuntime } from './runtime-cache.mjs';
import { COMPONENT_LIMITS } from './components.mjs';
import { prepareDshRuntime } from '../prepare-dsh-runtime.mjs';
const exec = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function installRuntime(runtime, ignoreScripts = false) {
  try { await exec('npm', ['ci', '--prefix', runtime, '--workspaces=false', '--omit=dev', '--no-audit', '--no-fund', ...(ignoreScripts ? ['--ignore-scripts'] : [])], { cwd: runtime, maxBuffer: 1024 * 1024 }); }
  catch { throw new Error('Locked runtime installation failed; inspect the build environment'); }
}

export async function packageFullRuntime({ repositoryRoot, packageRoot, sourceRevision, buildId }) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Full runtime currently requires Linux x64');
  const full = join(packageRoot, 'full'); await mkdir(join(full, 'core'), { recursive: true });
  const bundledPackages = new Map();
  for (const [source, name] of [['bin', 'main'], ['app-server-bin', 'app-server'], ['generation-bin', 'generations']]) {
    const bundle = await build({ metafile: true, absWorkingDir: repositoryRoot, entryPoints: [join(repositoryRoot, 'apps/codex-core/src', source + '.ts')], outfile: join(full, 'core', name + '.cjs'),
      bundle: true, platform: 'node', format: 'cjs', target: 'node26', external: ['bufferutil', 'utf-8-validate'] });
    for (const input of Object.keys(bundle.metafile.inputs)) {
      if (!input.includes('node_modules/')) continue;
      let directory = dirname(resolve(repositoryRoot, input));
      while (directory.startsWith(repositoryRoot)) {
        try { const manifest = JSON.parse(await readFile(join(directory, 'package.json')));
          if (manifest.name && manifest.version) { bundledPackages.set(directory, manifest); break; }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        directory = dirname(directory);
      }
    }
  }
  const coreLicenses = [];
  for (const [directory, manifest] of bundledPackages) {
    const label = manifest.name.replaceAll('/', '_') + '-' + manifest.version;
    const target = join(full, 'core/licenses', label); await mkdir(target, { recursive: true });
    const names = [];
    for (const name of await readdir(directory)) if (/^(?:LICENSE|NOTICE|COPYING)(?:[.-]|$)/i.test(name) && (await stat(join(directory, name))).isFile()) {
      await cp(join(directory, name), join(target, name)); names.push(name);
    }
    if (!names.length && !manifest.license) throw new Error('Bundled dependency has no license declaration');
    const record = { name: manifest.name, version: manifest.version, license: manifest.license || null, files: names };
    await writeFile(join(target, 'package-license.json'), JSON.stringify(record)); coreLicenses.push(record);
  }
  await writeFile(join(full, 'core/identity.json'), JSON.stringify({ schemaVersion: 1, sourceRevision, buildId }));
  // Installation runs solely in the separately pinned runtime, never a live HOME.
  const codex = join(repositoryRoot, 'runtime/codex');
  const codexPackage = JSON.parse(await readFile(join(codex, 'package.json')));
  const codexLock = JSON.parse(await readFile(join(codex, 'package-lock.json')));
  const version = codexPackage.dependencies['@openai/codex'];
  if (!/^\d+\.\d+\.\d+$/.test(version) || codexLock.packages['node_modules/@openai/codex']?.version !== version) throw new Error('CLI requires an exact lock');
  const records = [];
  await mkdir(join(packageRoot, 'release/locks'), { recursive: true });
  for (const [name, roots] of [['codex', ['@openai/codex']], ['dsh', ['@deepseek-ai/dsh', 'ajv']]]) {
    const source = join(repositoryRoot, 'runtime', name), target = join(full, name);
    const versions = await cachedRuntime({ repositoryRoot, name, destination: target, build: async destination => {
      if (name === 'dsh') await prepareDshRuntime({ root: repositoryRoot, log: () => {}, install: runtime => installRuntime(runtime) });
      else await installRuntime(codex, true);
      return copyDependencyClosure(join(destination, 'node_modules'), roots, createRequire(join(source, 'package.json')), source);
    } });
    const lock = await readFile(join(source, 'package-lock.json'));
    await cp(join(source, 'package.json'), join(target, 'package.json')); await writeFile(join(packageRoot, 'release/locks', name + '.json'), lock);
    await cp(join(repositoryRoot, 'LICENSE'), join(target, 'LICENSE'));
    records.push({ component: name, versions, lockfileSha256: digest(lock), packages: Object.fromEntries(Object.entries(JSON.parse(lock).packages).filter(([path]) => path).map(([path, p]) => [path, { version: p.version, integrity: p.integrity || null, resolved: p.resolved || null, license: p.license || null }])) });
  }
  await cp(join(repositoryRoot, 'LICENSE'), join(full, 'core/LICENSE'));
  const rootLock = await readFile(join(repositoryRoot, 'package-lock.json'));
  await writeFile(join(packageRoot, 'release/locks/workspace.json'), rootLock);
  await mkdir(join(packageRoot, 'release'), { recursive: true });
  const provenance = { schemaVersion: 1, license: 'Apache-2.0', sourceRevision, buildId,
    target: { platform: process.platform, arch: process.arch, nodeAbi: Number(process.versions.modules) },
    rootLockfileSha256: digest(rootLock), coreLicenses, componentLimits: COMPONENT_LIMITS, runtimes: records,
    activation: 'Payload only. Independent Core, generations, DSH, Pi, ACP and broker owners require a compatible P2/P3 plan.' };
  await writeFile(join(packageRoot, 'release/provenance.json'), JSON.stringify(provenance));
  await writeFile(join(packageRoot, 'release/LICENSE'), await readFile(join(repositoryRoot, 'LICENSE')));
  return provenance;
}
