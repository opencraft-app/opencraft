import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';

export const USER_PLUGIN_ABI = 1;
const idPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
// Operator-installed code is trusted, unlike browser module-URL installations.
// Its storage and public assets belong to the deployment, never a release.
export async function loadUserPlugins(directory) {
  let installed;
  try { installed = JSON.parse(await readFile(join(directory, 'plugins.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('User plugin installation is unreadable'); }
  if (installed.schemaVersion !== USER_PLUGIN_ABI || !Array.isArray(installed.plugins)) throw new Error('Unsupported user plugin installation');
  const ids = new Set();
  for (const plugin of installed.plugins) {
    const id = plugin.manifest?.id;
    if (!idPattern.test(id || '') || ids.has(id) || typeof plugin.manifest?.version !== 'string'
      || typeof plugin.manifest?.name !== 'string' || plugin.manifest?.apiVersion !== 1
      || plugin.manifest?.manifestVersion !== 1 || !/^[a-f0-9]{64}$/.test(plugin.sha256 || '')
      || plugin.entry !== `${id}/plugin.mjs` || !Array.isArray(plugin.replaces)
      || !plugin.replaces.every(value => idPattern.test(value) && value !== id)) throw new Error('Invalid user plugin installation');
    if (plugin.branding !== undefined && (typeof plugin.branding?.name !== 'string' || !plugin.branding.name.trim()
      || !['faviconUrl', 'markUrl', 'appleTouchIconUrl'].every(key => plugin.branding[key] === undefined
        || (typeof plugin.branding[key] === 'string' && plugin.branding[key].startsWith(`/__opencraft_plugins/${id}/`) && !/[\\<>"\s]/.test(plugin.branding[key]))))) throw new Error('Invalid user plugin branding');
    ids.add(id);
    const path = await userPluginAsset(directory, plugin.entry);
    if (createHash('sha256').update(await readFile(path)).digest('hex') !== plugin.sha256) throw new Error('User plugin integrity mismatch');
  }
  return installed.plugins;
}
export async function userPluginAsset(directory, relative) {
  if (relative.includes('\\') || relative.includes('\0') || relative.split('/').some(part => part === '..' || part.startsWith('.'))) throw new Error('Invalid user plugin asset');
  const root = await realpath(join(directory, 'public'));
  const path = await realpath(resolve(root, relative));
  if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) throw new Error('Invalid user plugin asset');
  return path;
}
export async function assertUserPluginCompatibility(release, plugins) {
  if (!plugins?.length) return;
  const manifest = JSON.parse(await readFile(join(release.releaseRoot, 'package.json'), 'utf8'));
  if (manifest.opencraftWeb?.userPlugins !== USER_PLUGIN_ABI) throw new Error('Release cannot load installed user plugins; plugins were preserved. Select a compatible release.');
}
