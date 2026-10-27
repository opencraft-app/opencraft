import { parseExtensionManifestV1, type ExtensionManifestV1 } from '@opencraft/extension-contract';
import type { ManagedBuiltinExtension, TrustedExtensionDefinition } from '@opencraft/extension-runtime';
import { serverUrl } from './server-context';

export interface ServerInstalledExtension {
  readonly manifest: ExtensionManifestV1;
  readonly entry: string;
  readonly sha256: string;
  readonly replaces: readonly string[];
}
export function parseServerInstalledExtensions(value: unknown): readonly ServerInstalledExtension[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid server-installed plugins');
  return value.map(item => {
    const manifest = parseExtensionManifestV1(item.manifest);
    if (item.entry !== `${manifest.id}/plugin.mjs` || !/^[a-f0-9]{64}$/.test(item.sha256)
      || !Array.isArray(item.replaces) || !item.replaces.every((id: unknown) => typeof id === 'string')) throw new Error('Invalid server-installed plugin');
    return { manifest, entry: item.entry, sha256: item.sha256, replaces: item.replaces };
  });
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
export function serverInstalledBuiltins(installed: readonly ServerInstalledExtension[], ports = browserPorts): readonly ManagedBuiltinExtension[] {
  return installed.map(plugin => ({
    manifest: plugin.manifest,
    defaultEnabled: true,
    async load() {
      const response = await ports.fetch(serverUrl(`/__opencraft_plugins/${plugin.entry}`), { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Installed plugin is unavailable');
      const code = await response.text();
      if (new TextEncoder().encode(code).length > 512 * 1024) throw new Error('Installed plugin is too large');
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
      if (Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('') !== plugin.sha256) throw new Error('Installed plugin integrity mismatch');
      const definition = (await ports.importModule(code)).default;
      if (JSON.stringify(parseExtensionManifestV1(definition.manifest)) !== JSON.stringify(plugin.manifest)
        || typeof definition.activate !== 'function') throw new Error('Installed plugin identity mismatch');
      return definition;
    },
  }));
}
