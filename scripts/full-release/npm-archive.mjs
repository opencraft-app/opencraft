// Use the build owner's installed npm for selection and tar semantics. The
// content inventory belongs to one frozen staging transaction. Cached path
// selection is revalidated against that transaction's topology and npm policy.
import { realpath, stat, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { parseNpmPackResult } from '../web-deployment/npm-pack-result.mjs';
import { selectWithCache } from './selection-cache.mjs';
const exec = promisify(execFile);
export function packageGzipLevel(value = process.env.OPENCRAFT_PACKAGE_GZIP_LEVEL ?? '9') {
  if (!/^[1-9]$/.test(String(value))) throw new Error('Package gzip level must be an integer from 1 through 9');
  return Number(value);
}
export async function selectNpmFiles(root, { cacheDirectory = process.env.OPENCRAFT_PACKAGE_CACHE_DIR } = {}) {
  const { stdout } = await exec('which', ['npm']);
  const npmPath = await realpath(stdout.trim());
  const npm = createRequire(npmPath);
  const tree = await new (npm('@npmcli/arborist'))({ path: root }).loadActual();
  const names = await selectWithCache({ root, tree, packlist: npm('npm-packlist'), cacheDirectory,
    toolchain: [process.version, process.platform, process.arch, stdout.trim(),
      npmPath, JSON.parse(await readFile(join(dirname(npmPath), '../package.json'), 'utf8')).version,
      ...await Promise.all(['npm-packlist', 'ignore-walk', 'minimatch', '@npmcli/arborist'].map(async name =>
        createHash('sha256').update(await readFile(npm.resolve(name))).digest('hex')))] });
  const manifest = tree.package;
  return { root, names, manifest, tar: npm('tar'), options: npm('pacote').DirFetcher.tarCreateOptions({ ...manifest, _resolved: root }) };
}
export async function packSelectedArchive(selection, directory, inventory, gzipLevel = packageGzipLevel()) {
  gzipLevel = packageGzipLevel(gzipLevel);
  const { root, names, manifest, tar, options } = selection;
  const filename = `${manifest.name.replace(/^@/, '').replace(/[/\\]/g, '-')}-${manifest.version}.tgz`;
  // Preserve npm's filename validation before opening anything in the output.
  parseNpmPackResult([{ filename }]);
  const known = new Map(inventory.map(([path, , size, mode]) => [path, { path, size, mode: parseInt(mode, 8) }]));
  const files = [];
  for (const name of names) {
    let file = known.get(name);
    if (!file) {
      if (!['release/full-release.json', 'release/full-release.sig'].includes(name)) throw new Error('Archive selection differs from signed inventory');
      const info = await stat(join(root, name));
      options.filter?.(name, info);
      file = { path: name, size: info.size, mode: info.mode & 0o777 };
    }
    files.push(file);
  }
  const sha1 = createHash('sha1'), sha512 = createHash('sha512');
  let size = 0;
  const meter = new Transform({ transform(chunk, encoding, done) {
    size += chunk.length; sha1.update(chunk); sha512.update(chunk); done(null, chunk);
  } });
  await pipeline(tar.c({ ...options, gzip: { level: gzipLevel } }, names), meter,
    createWriteStream(join(directory, filename), { flags: 'wx', mode: 0o600 }));
  // These fields retain the npm pack result contract without buffering and
  // decompressing the archive solely to count bytes we already inventoried.
  const bundled = [...new Set(files.map(f => f.path.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1]).filter(Boolean))];
  const collator = new Intl.Collator('en', { sensitivity: 'case', numeric: true });
  const upper = s => s[0] === s[0].toUpperCase();
  files.sort((a, b) => Number(upper(b.path)) - Number(upper(a.path)) || collator.compare(a.path, b.path));
  return { id: manifest._id || `${manifest.name}@${manifest.version}`, name: manifest.name, version: manifest.version,
    filename, size, unpackedSize: files.reduce((sum, file) => sum + file.size, 0),
    shasum: sha1.digest('hex'), integrity: `sha512-${sha512.digest('base64')}`, files, entryCount: files.length,
    bundled };
}
