import { build } from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';

/** Programs sharing the independent Codex Core installation directory. */
export async function bundleCodexCore({ repositoryRoot, directory }) {
  await mkdir(directory, { recursive: true });
  const bundledPackages = new Map();
  for (const [source, name, format] of [
    ['bin', 'main.cjs', 'cjs'], ['app-server-bin', 'app-server.cjs', 'cjs'],
    ['generation-bin', 'generations.cjs', 'cjs'],
    ['router-evidence.worker', 'router-evidence-worker.mjs', 'esm'],
  ]) {
    const bundle = await build({ metafile: true, absWorkingDir: repositoryRoot,
      entryPoints: [join(repositoryRoot, 'apps/codex-core/src', source + '.ts')], outfile: join(directory, name),
      bundle: true, platform: 'node', format, target: 'node26', external: ['bufferutil', 'utf-8-validate', 'node-pty'], logLevel: 'silent' });
    for (const input of Object.keys(bundle.metafile.inputs)) {
      if (!input.includes('node_modules/')) continue;
      let current = dirname(resolve(repositoryRoot, input));
      while (current.startsWith(repositoryRoot)) {
        try {
          const manifest = JSON.parse(await readFile(join(current, 'package.json')));
          if (manifest.name && manifest.version) { bundledPackages.set(current, manifest); break; }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        current = dirname(current);
      }
    }
  }
  return bundledPackages;
}
