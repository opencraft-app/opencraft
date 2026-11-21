import { headlessBackendRoutes } from './headless-backend.mjs';
import { resolve, dirname, join } from 'node:path';
import { createOptionalResources } from './optional-resources.mjs';
import { readFile } from 'node:fs/promises';
import { createWorkbenchWebServer } from '../workbench-web-server.mjs';
import { inspectRelease } from './releases.mjs';
import { prepareProductPluginRelease } from '../../apps/headless-server/src/web-deployment/product-plugin-packs.mjs';
const identity = await inspectRelease(process.env.OPENCRAFT_RELEASE_ROOT);
const manifest = JSON.parse(await readFile(`${identity.releaseRoot}/package.json`, 'utf8'));
// Runs before listen; old installed controllers already pass this persistent
// deployment directory. No resident-controller upgrade is required to read a pack.
const pluginCache = process.env.OPENCRAFT_PRODUCT_PLUGIN_CACHE_DIRECTORY || join(process.env.OPENCRAFT_USER_PLUGIN_DIRECTORY
  ? dirname(process.env.OPENCRAFT_USER_PLUGIN_DIRECTORY) : process.env.OPENCRAFT_WEB_STATE || resolve(identity.releaseRoot, '../../..'), 'product-plugin-packs');
const productPluginAssets = await prepareProductPluginRelease({ releaseRoot: identity.releaseRoot, cacheDirectory: pluginCache,
  metadata: manifest.opencraftWeb.productPlugins ?? null });
const optionalResources = await createOptionalResources({ releaseRoot: identity.releaseRoot,
  cacheDirectory: process.env.OPENCRAFT_RESOURCE_CACHE_DIRECTORY || resolve(process.env.OPENCRAFT_WEB_STATE || resolve(identity.releaseRoot, '../../..'), 'resource-cache'),
  registry: process.env.OPENCRAFT_NPM_REGISTRY, userconfig: process.env.OPENCRAFT_NPM_USERCONFIG });
const server = await createWorkbenchWebServer({ userPluginDirectory: process.env.OPENCRAFT_USER_PLUGIN_DIRECTORY || null, optionalResources, machineDisplayNames: process.env.OPENCRAFT_MACHINE_DISPLAY_NAMES ? JSON.parse(process.env.OPENCRAFT_MACHINE_DISPLAY_NAMES) : null, root: `${identity.releaseRoot}/web`, headlessServer: manifest.opencraftExecution?.profile === 'headless', appServerTarget: process.env.OPENCRAFT_APPSERVER_URL || null,
  productPluginAssets, headlessBackendTarget: process.env.OPENCRAFT_HEADLESS_BACKEND_URL || null,
  codexServerTarget: process.env.OPENCRAFT_CODEX_APPSERVER_URL || null, hyperNodeUser: process.env.OPENCRAFT_HYPERNODE_USER || '' });
const address = await server.listen({ host: '127.0.0.1', port: 0 });
process.send?.({ protocol: 1, port: address.port, version: identity.version, buildId: identity.buildId, headlessBackendRoutes });
const close = async () => { await server.close(); process.exit(0); };
process.once('SIGTERM', close); process.once('SIGINT', close); process.once('disconnect', close);
