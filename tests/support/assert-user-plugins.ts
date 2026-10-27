import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { ExtensionManager, ExtensionSupervisor, MemoryExtensionInstallationPersistence, provideExtensionInstallationRepository } from '@opencraft/extension-runtime';
import { parseWebDeploymentConfig } from '../../apps/workbench-web/src/runtime/web-deployment-config';
import { serverInstalledBuiltins } from '../../apps/workbench-web/src/runtime/server-installed-extensions';
import { ApplicationBrandingRegistry } from '../../apps/workbench-web/src/runtime/application-branding';

// Exercise the same parser, integrity loader, registry and lifecycle as the Web
// client. Transport/module evaluation are Node ports; no browser installation
// artifact is promoted into this operator-only trust path.
export async function assertInstalledPlugins(base: string) {
  const html = await (await fetch(base + '/')).text();
  const config = parseWebDeploymentConfig(html.match(/<script id="opencraft-deployment-config" type="application\/json">(.*?)<\/script>/s)?.[1] ?? null)!;
  const plugins = config.userPlugins!;
  const registry = new ApplicationBrandingRegistry();
  const supervisor = new ExtensionSupervisor({ platform: 'web', internalContributions: { applicationBranding: registry.createAdapter() } });
  const context = new Context();
  const fiber = context.plugin(provideExtensionInstallationRepository(new MemoryExtensionInstallationPersistence()));
  await fiber;
  const builtin = serverInstalledBuiltins(plugins, {
    fetch: (url, options) => fetch(new URL(url, base), options),
    importModule: code => import('data:text/javascript;base64,' + Buffer.from(code).toString('base64')),
  });
  // This is the same explicit replacement policy used by the production owner.
  const replaced = new Set(plugins.flatMap(plugin => plugin.replaces));
  const defaultPlugin = { manifest: { ...plugins[0]!.manifest, id: 'fixture.default' }, defaultEnabled: true,
    async load() { throw new Error('Replaced default plugin must never load'); } };
  const manager = new ExtensionManager({ installations: context.extensionInstallations, supervisor,
    loader: { async load() { throw new Error('Unexpected external plugin'); } },
    builtins: [...builtin, defaultPlugin].filter(plugin => !replaced.has(plugin.manifest.id)),
  });
  try {
    await manager.restore();
    assert.equal(registry.getSnapshot().contribution?.name, 'User brand');
    assert.equal(manager.getSnapshot().extensions.find(item => item.installation.extensionId === 'user.example')?.status, 'active');
    assert.equal(manager.getSnapshot().extensions.some(item => item.installation.extensionId === 'fixture.default'), false);
  } finally { await manager.dispose(); await supervisor.dispose(); await fiber.dispose(); }
}
