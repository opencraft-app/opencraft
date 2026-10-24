import { cp, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/** Required JavaScript closure only; optional CPU/crypto accelerators are not deployed. */
export async function copySshRuntime(destination) {
  const copied = new Set();
  async function copy(name, from = require) {
    if (copied.has(name)) return;
    copied.add(name);
    const root = dirname(from.resolve(`${name}/package.json`));
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    await mkdir(destination, { recursive: true });
    await cp(root, join(destination, name), { recursive: true,
      filter: path => !path.includes('/build/') && !path.includes('/test/') && !path.endsWith('.node') });
    const childRequire = createRequire(join(root, 'package.json'));
    for (const dependency of Object.keys(manifest.dependencies || {})) await copy(dependency, childRequire);
  }
  await copy('ssh2');
}
