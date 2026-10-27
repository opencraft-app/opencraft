import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RESOURCE_PACKAGE } from './web-deployment/optional-resources.mjs';
import { assertPackageName } from './web-deployment/package-identity.mjs';
import { parseNpmPackResult } from './web-deployment/npm-pack-result.mjs';

async function copyOfficeLicenses(repositoryRoot, packageRoot) {
  const queue = ['@opencraft/plugin-office-preview', '@opencraft/plugin-structured-preview'].map(name => ({ name, from: join(repositoryRoot, 'package.json') }));
  const seen = new Set();
  const manifest = [];
  while (queue.length) {
    const { name, from } = queue.shift();
    const resolver = createRequire(from);
    let source;
    for (const directory of resolver.resolve.paths('opencraft-preview-license') ?? []) {
      try { await readFile(join(directory, name, 'package.json')); source = join(directory, name); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!source) throw new Error(`Missing preview dependency: ${name}`);
    const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    const identity = `${metadata.name}@${metadata.version}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    for (const dependency of Object.keys(metadata.dependencies ?? {})) queue.push({ name: dependency, from: join(source, 'package.json') });
    if (metadata.name.startsWith('@opencraft/')) continue;
    const entries = await readdir(source);
    const files = entries.filter(file => /^(?:licen[cs]e|copying|notice|authors)(?:[.-]|$)/i.test(file));
    if (!files.length) files.push(...entries.filter(file => /^readme(?:[.-]|$)/i.test(file)));
    const target = join(packageRoot, 'web/licenses/office', metadata.name.replaceAll('/', '__'));
    await mkdir(target, { recursive: true });
    for (const file of files) await cp(join(source, file), join(target, file), { recursive: true });
    // The 0.1.23 npm archive omits its repository's MIT notice.
    if (metadata.name === '@dukelib/sheets-wasm' && metadata.version === '0.1.23' && !files.length) {
      await cp(join(repositoryRoot, 'plugins/office-preview/licenses/duke-sheets-MIT.txt'), join(target, 'LICENSE'));
      files.push('LICENSE');
    }
    if (metadata.name === '@extend-ai/react-docx') {
      await cp(join(repositoryRoot, 'plugins/office-preview/licenses/react-docx-MIT.txt'), join(target, 'LICENSE'));
      await cp(join(source, 'dist/dingbat-to-unicode-LICENSE'), join(target, 'dingbat-to-unicode-LICENSE'));
      files.push('LICENSE', 'dingbat-to-unicode-LICENSE');
    }
    manifest.push({ name: metadata.name, version: metadata.version, license: metadata.license ?? null, files });
  }
  await writeFile(join(packageRoot, 'web/licenses/office/dependencies.json'), JSON.stringify(manifest, null, 2));
}

export async function copyPdfLicenses(repositoryRoot, packageRoot) {
  await copyOfficeLicenses(repositoryRoot, packageRoot);
  await cp(join(repositoryRoot, 'plugins/structured-preview/licenses'), join(packageRoot, 'web/licenses/structured'), { recursive: true });
  const licenses = join(packageRoot, 'web/licenses/pdfjs');
  await mkdir(licenses, { recursive: true });
  await cp(join(repositoryRoot, 'node_modules/pdfjs-dist/LICENSE'), join(licenses, 'LICENSE'));
  for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
    const source = join(repositoryRoot, 'node_modules/pdfjs-dist', directory);
    const target = join(licenses, directory);
    await mkdir(target, { recursive: true });
    for (const file of await readdir(source)) if (file.startsWith('LICENSE')) await cp(join(source, file), join(target, file));
  }
}

export async function packageWebResources({ repositoryRoot, packageRoot, directory, version, buildId, packageName = RESOURCE_PACKAGE, registry }) {
  assertPackageName(packageName);
  let selection;
  try { selection = JSON.parse(await readFile(join(packageRoot, 'web/optional-assets.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (selection.schemaVersion !== 1 || !Array.isArray(selection.files)
    || selection.files.some(file => !/^assets\/(?:[A-Za-z0-9_.~-]+|excalidraw-fonts\/fonts\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.woff2)$/.test(file) || file.endsWith('.map'))) throw new Error('Invalid optional build assets');
  await rm(join(packageRoot, 'web/optional-assets.json'));
  if (!selection.files.length) return null;
  const output = join(directory, 'resources');
  const root = join(output, 'package');
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, 'web/assets'), { recursive: true });
  for (const file of selection.files) {
    await mkdir(dirname(join(root, 'web', file)), { recursive: true });
    await cp(join(packageRoot, 'web', file), join(root, 'web', file));
    await rm(join(packageRoot, 'web', file));
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: packageName, version, description: 'Optional, versioned OpenCraft Web preview resources',
    files: ['web', 'LICENSE'], opencraftAssets: { schemaVersion: 1, buildId }, ...(registry ? { publishConfig: { registry } } : {}),
    repository: { type: 'git', url: 'git+https://github.com/opencraft-app/opencraft.git' },
  }, null, 2));
  await cp(join(repositoryRoot, 'node_modules/pdfjs-dist/LICENSE'), join(root, 'LICENSE'));
  await copyPdfLicenses(repositoryRoot, root);
  const { stdout } = await promisify(execFile)('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  const packed = parseNpmPackResult(JSON.parse(stdout));
  const reference = { packageName, version, buildId, integrity: packed.integrity };
  await writeFile(join(packageRoot, 'web/optional-resources.json'), JSON.stringify({ schemaVersion: 1, packs: [{ ...reference, files: selection.files }] }));
  return { ...reference, packageRoot: root, archive: join(output, packed.filename), sha: packed.shasum };
}
