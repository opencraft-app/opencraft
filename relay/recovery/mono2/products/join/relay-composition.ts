import { joinEntryOrigin } from './relay-entry-aliases.js';
import { readPrivateJson } from '../../opencraft/packages/identity-core/src/node.js';
import { TencentOaServerPlugin } from './plugins/tencentoa/src/server.js';
import { parseRelayConfiguration, type RelayComposition } from '../../opencraft/apps/relay-server/src/application.js';
import type { IdentityProvider } from '../../opencraft/packages/identity-core/src/node.js';

/** Product-owned compatibility with the deployed Join configuration, not a core schema. */
export function joinRelayConfiguration(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Join relay configuration');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['schemaVersion', 'issuer', 'privateKey', 'tencentOaTokenFile', 'authenticationOrigin', 'port', 'host', 'routes', 'tlsCertFile', 'tlsKeyFile', 'tlsTermination', 'hubNetwork', 'serverSelection', 'serverSelectionDefaultsFile', 'serverPaths'].includes(key))) throw new Error('Invalid Join relay configuration');
  const keys = ['issuer', 'privateKey', 'tencentOaTokenFile', 'authenticationOrigin'];
  const enabled = keys.some(key => value[key] !== undefined);
  if (enabled && !keys.every(key => typeof value[key] === 'string' && value[key] !== '')) throw new Error('Incomplete Join identity gateway configuration');
  const { issuer, privateKey, tencentOaTokenFile, authenticationOrigin, ...rest } = value;
  const configuration = parseRelayConfiguration({ ...rest, ...(enabled ? { authentication: { issuer, privateKey, origin: authenticationOrigin, providers: ['tencentoa'] } } : {}) });
  let webIdentity: IdentityProvider | undefined;
  const composition: RelayComposition = enabled ? { ...(configuration.serverSelection ? { entryOrigin: joinEntryOrigin(String(authenticationOrigin)) } : {}), createIdentity: async () => {
    const plugin = await TencentOaServerPlugin.fromTokenFile(String(tencentOaTokenFile));
    webIdentity = plugin.identityProvider();
    return { provider: webIdentity, close: () => { webIdentity = undefined; return plugin.close(); } };
  } } : {};
  return { configuration, composition, authenticateWebRequest: (request: Parameters<IdentityProvider['authenticate']>[0]) => webIdentity?.authenticate(request) ?? null };
}
export async function readJoinRelayConfiguration(path: string) { return joinRelayConfiguration(await readPrivateJson(path)); }
