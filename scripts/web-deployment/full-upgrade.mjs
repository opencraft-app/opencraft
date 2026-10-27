import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readConfig, socketPath } from '../full-upgrade/service-config.mjs';
import { request } from '../full-upgrade/ipc.mjs';
import { invariant } from '../full-upgrade/durable.mjs';
// The deployment entry chooses a protected fixed local configuration. Nothing
// from HTTP may choose sockets, paths, commands, owner IDs or recipe contents.
export async function upgradeBridge(configPath, webState) {
  if (!configPath) return null;
  const config = await readConfig(configPath);
  invariant(resolve(config.webState) === resolve(webState), 'upgrade-deployment-mismatch');
  return input => request(socketPath(config, 'agent'), input, 120000);
}
export async function installedUpgradeConfig(webState, configPath = '/etc/opencraft-upgrade/config.json') {
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    return resolve(config.webState) === resolve(webState) ? configPath : null;
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
