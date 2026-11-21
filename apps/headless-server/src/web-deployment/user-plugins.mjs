import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';

export const USER_PLUGIN_ABI = 1;
const idPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
/** Plugin discovery is independent of Host/bootstrap configuration. */
export function injectUserPluginBootstrap(html, plugins) {
  if (!plugins?.length) return html;
  const json = JSON.stringify(plugins).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return html.replace(/<head(?:\s[^>]*)?>/iu, head => `${head}<script id="opencraft-user-plugins" type="application/json">${json}</script>`);
}
// Operator-installed code is trusted, unlike browser module-URL installations.
// Its storage and public assets belong to the deployment, never a release.
export async function loadUserPlugins(directory, { isolate = false, onDiagnostic = () => {} } = {}) {
  const report = (id, message) => { try { onDiagnostic({ extensionId: idPattern.test(id || '') ? id : '*', message }); } catch {} };
  try { return await readInstallation(); }
  catch (error) {
    if (!isolate) throw error;
    report('*', 'plugin_installation_unavailable');
    return [];
  }
  async function readInstallation() {
  let installed;
  try {
    const index = join(directory, 'plugins.json');
    if ((await stat(index)).size > 2 * 1024 * 1024) throw new Error('User plugin index too large');
    installed = JSON.parse(await readFile(index, 'utf8'));
  }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('User plugin installation is unreadable'); }
  if (installed.schemaVersion !== USER_PLUGIN_ABI || !Array.isArray(installed.plugins) || installed.plugins.length > 128) throw new Error('Unsupported user plugin installation');
  const ids = new Set(), plugins = [];
  const counts = new Map();
  for (const plugin of installed.plugins) {
    const id = plugin?.manifest?.id;
    if (typeof id === 'string') counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const plugin of installed.plugins) {
    const id = plugin?.manifest?.id;
    try {
    if (isolate && counts.get(id) > 1) { report(id, 'plugin_id_conflict'); continue; }
    if (!idPattern.test(id || '') || ids.has(id) || typeof plugin.manifest?.version !== 'string'
      || typeof plugin.manifest?.name !== 'string' || plugin.manifest?.apiVersion !== 1
      || plugin.manifest?.manifestVersion !== 1 || !/^[a-f0-9]{64}$/.test(plugin.sha256 || '')
      || plugin.entry !== `${id}/plugin.mjs` || !Array.isArray(plugin.replaces)
      || !plugin.replaces.every(value => idPattern.test(value) && value !== id)) throw new Error('Invalid user plugin installation');
    if ((plugin.renderer !== undefined && plugin.renderer !== 'trusted-react-v1')
      || (plugin.configuration !== undefined && (!plugin.configuration || typeof plugin.configuration !== 'object' || Array.isArray(plugin.configuration)
        || JSON.stringify(plugin.configuration).length > 65536))) throw new Error('Invalid installed renderer');
    if (plugin.access !== undefined) throw new Error('Operator installation cannot grant public craft descriptors');
    if (plugin.branding !== undefined && (typeof plugin.branding?.name !== 'string' || !plugin.branding.name.trim()
      || !['faviconUrl', 'markUrl', 'appleTouchIconUrl'].every(key => plugin.branding[key] === undefined
        || (typeof plugin.branding[key] === 'string' && plugin.branding[key].startsWith(`/__opencraft_plugins/${id}/`) && !/[\\<>"\s]/.test(plugin.branding[key]))))) throw new Error('Invalid user plugin branding');
    ids.add(id);
    const path = await userPluginAsset(directory, plugin.entry);
    if ((await stat(path)).size > 512 * 1024) throw new Error('User plugin is too large');
    if (createHash('sha256').update(await readFile(path)).digest('hex') !== plugin.sha256) throw new Error('User plugin integrity mismatch');
    plugins.push(plugin);
    } catch (error) {
      if (!isolate) throw error;
      report(id, 'plugin_package_invalid');
    }
  }
  if (isolate && plugins.filter(plugin => plugin.branding).length > 1) {
    return plugins.filter(plugin => {
      if (!plugin.branding) return true;
      report(plugin.manifest.id, 'plugin_branding_conflict'); return false;
    });
  }
  return plugins;
  }
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
