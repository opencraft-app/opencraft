import { parseExtensionManifestV1, type ExtensionManifestV1 } from '@opencraft/extension-contract';
import type { ManagedBuiltinExtension, TrustedExtensionDefinition } from '@opencraft/extension-runtime';
import { serverUrl } from './server-context';
import { assertSelfContained, publicExtensionDefinition } from './module-url-extension-loader';

export interface ServerInstalledExtension {
  readonly manifest: ExtensionManifestV1;
  readonly entry: string;
  readonly sha256: string;
  readonly replaces: readonly string[];
  readonly access?: 'public';
  /** Administrator-installed native View factory; not granted to public craft. */
  readonly renderer?: 'trusted-react-v1';
  readonly configuration?: Readonly<Record<string, unknown>>;
}
export function parseServerInstalledExtensions(value: unknown): readonly ServerInstalledExtension[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid server-installed plugins');
  return value.map(item => {
    const manifest = parseExtensionManifestV1(item.manifest);
    const entryParts = typeof item.entry === 'string' ? item.entry.split('/') : [];
    const validEntry = entryParts[0] === manifest.id && (entryParts.length === 2 && entryParts[1] === 'plugin.mjs'
      || entryParts.length === 3 && /^[a-f0-9]{64}$/.test(entryParts[1]!) && entryParts[2] === 'plugin.mjs');
    if (!validEntry || !/^[a-f0-9]{64}$/.test(item.sha256)
      || (item.access !== undefined && item.access !== 'public')
      || !Array.isArray(item.replaces) || !item.replaces.every((id: unknown) => typeof id === 'string')) throw new Error('Invalid server-installed plugin');
    if ((item.renderer !== undefined && item.renderer !== 'trusted-react-v1')
      || (item.configuration !== undefined && (!item.configuration || typeof item.configuration !== 'object' || Array.isArray(item.configuration)))) throw new Error('Invalid installed renderer');
    if (item.access === 'public' && (item.replaces.length || item.renderer !== undefined || item.configuration !== undefined)) throw new Error('Craft plugins cannot replace internal extensions');
    return { manifest, entry: item.entry, sha256: item.sha256, replaces: item.replaces, ...(item.access === 'public' ? { access: 'public' as const } : {}),
      ...(item.renderer ? { renderer: item.renderer as 'trusted-react-v1' } : {}), ...(item.configuration ? { configuration: item.configuration } : {}) };
  });
}
/** Host configuration and installed code have different owners. Old Web
 * workers still advertise plugins in deployment config; new gateways use a
 * dedicated inert bootstrap and leave the Host selection untouched. */
export function readServerInstalledExtensions(fallback: readonly ServerInstalledExtension[] = [], root = document): readonly ServerInstalledExtension[] {
  try {
    const script = root.getElementById('opencraft-user-plugins');
    const value: unknown = script ? JSON.parse(script.textContent ?? 'null') : fallback;
    if (!Array.isArray(value) || value.length > 128) return [];
    const counts = new Map<string, number>();
    for (const item of value) {
      const id = item?.manifest?.id;
      if (typeof id === 'string') counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return value.flatMap(item => {
      try {
        if (counts.get(item?.manifest?.id) !== 1) return [];
        return parseServerInstalledExtensions([item]);
      } catch { return []; }
    });
  } catch { return []; }

}
/** Server-owned plugins share the existing extension lifecycle and storage. */
const browserPorts = {
  fetch: (url: string, options: RequestInit) => fetch(url, options),
  async importModule(code: string): Promise<{ default: TrustedExtensionDefinition }> {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    try { return await import(/* @vite-ignore */ url); }
    finally { URL.revokeObjectURL(url); }
  },
};
export function serverInstalledBuiltins(installed: readonly ServerInstalledExtension[], ports = browserPorts,
  context: { readonly tasks?: () => import("@opencraft/plugin-tasks").TasksExtensionPorts; readonly getClient?: (hostId: string) => import('@opencraft/appserver-client').AppServerClient | undefined } = {}): readonly ManagedBuiltinExtension[] {
  return installed.map(plugin => ({
    origin: 'user' as const,
    manifest: plugin.manifest,
    // Filesystem discovery is not the user's consent to execute new code.
    // Existing enable/disable intent remains owned by ExtensionManager.
    defaultEnabled: plugin.access !== 'public',
    async load() {
      const response = await ports.fetch(serverUrl(`/__opencraft_plugins/${plugin.entry}`), { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Installed plugin is unavailable');
      const code = await response.text();
      if (new TextEncoder().encode(code).length > 512 * 1024) throw new Error('Installed plugin is too large');
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
      if (Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('') !== plugin.sha256) throw new Error('Installed plugin integrity mismatch');
      if (plugin.access === 'public') await assertSelfContained(code);
      const module = await ports.importModule(code);
      const definition = plugin.renderer === 'trusted-react-v1'
        ? await (await import('./trusted-renderer-host')).loadTrustedRenderer(module.default, plugin.configuration ?? {}, context.getClient, context.tasks)
        : module.default;
      if (JSON.stringify(parseExtensionManifestV1(definition.manifest)) !== JSON.stringify(plugin.manifest)
        || typeof definition.activate !== 'function') throw new Error('Installed plugin identity mismatch');
      return plugin.access === 'public' ? publicExtensionDefinition(definition) : definition;
    },
  }));
}
