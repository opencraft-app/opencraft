import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileListDigest, sha256 } from './contract.mjs';
export const COMPONENT_LIMITS = Object.freeze({
  web: [512 * 1024 ** 2, 20000], runtime: [1536 * 1024 ** 2, 20000], execution: [512 * 1024 ** 2, 20000],
  node_modules: [1024 ** 3, 40000], 'full/core': [128 * 1024 ** 2, 1000],
  'full/codex': [768 * 1024 ** 2, 2000], 'full/dsh': [2 * 1024 ** 3, 60000], release: [16 * 1024 ** 2, 32],
});
export function fullComponents(files, pkg, template) {
  const grouped = new Map();
  for (const file of files) {
    const path = file[0], parts = path.split('/');
    const root = parts[0] === 'full' ? parts.slice(0, 2).join('/') : parts[0];
    if (parts.length > 1 && !Object.hasOwn(COMPONENT_LIMITS, root)) throw new Error('Unknown full release component root');
    if (!grouped.has(root)) grouped.set(root, []); grouped.get(root).push(file);
  }
  return [...grouped].map(([root, fileList]) => {
    const [bytes, entries] = COMPONENT_LIMITS[root] || [16 * 1024 ** 2, 1];
    const unpackedBytes = fileList.reduce((n, f) => n + f[2], 0);
    if (unpackedBytes > bytes || fileList.length > entries) throw new Error('Full release component budget exceeded: ' + root);
    const licenses = root.includes('/') || Object.hasOwn(COMPONENT_LIMITS, root)
      ? fileList.filter(([name]) => /(?:^|\/)(?:LICENSE(?:\.[^/]*)?|NOTICE(?:\.[^/]*)?)$/i.test(name)).map(([name]) => name) : [root];
    if (!licenses.length) throw new Error('Full release component license missing: ' + root);
    const role = root === 'full/core' ? 'core' : root === 'full/codex' ? 'cli' : root === 'full/dsh' ? 'dsh' : root === 'node_modules' ? 'pi-and-mcp' : root === 'execution' ? 'hosts-and-native' : root === 'runtime' ? 'bootstrap-and-broker' : root === 'web' ? 'web' : 'distribution';
    return { componentId: role + '-' + sha256(Buffer.from(root)).slice(0, 12), role, version: pkg.version, buildId: pkg.opencraftWeb.buildId,
      sourceRevision: template.release.source.revision, required: true, enabledPolicy: 'preserve',
      content: { kind: 'tree', root, fileListSha256: fileListDigest(fileList), unpackedBytes, entries: fileList.length }, fileList,
      provides: [], requires: [], activation: { strategy: 'helper', unitRole: role, authority: 'unsupported', retainedHistory: true }, licenses };
  });
}

export async function prepareFullMetadata(packageRoot) {
  for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === 'package.json' || /^(LICENSE|NOTICE)(\.|$)/i.test(entry.name)) continue;
    const path = join(packageRoot, entry.name), text = await readFile(path, 'utf8');
    if (!text.includes('SPDX-License-Identifier: Apache-2.0')) await writeFile(path, text + '\n' + (entry.name.endsWith('.service') ? '# ' : '') + 'SPDX-License-Identifier: Apache-2.0\n');
  }
}
