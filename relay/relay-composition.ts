import { createRtxLoginPreparation } from '../products/join/plugins/tencentoa/src/rtx-directory.mjs';
import { createIpEnrollmentIngress, HUB_ENROLLMENT_PATH } from './ip-enrollment.js';
import { createMirrorIngress, createForwardingIngress, MIRROR_PATH } from '../products/join/plugins/wecom/mirror/main.mjs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';
import { joinEntryOrigin } from './relay-entry-aliases.js';
import { readPrivateJson, type IdentityProvider } from '../packages/identity-core/src/node.js';
import { TencentOaServerPlugin } from '../products/join/plugins/tencentoa/src/server.js';
import { parseRelayConfiguration, type RelayComposition } from '../apps/relay-server/src/application.js';
import { createTestEnvironmentIngress } from './test-environment.js';
import { createWeComCallbackIngress, parseWeComCallbackTarget } from './wecom-callback.js';
import { RelayRedis, readRelayRedisConfiguration } from '../apps/relay-server/src/redis.js';

/** Translate legacy mono2 settings at the Join boundary and accept the deployed core schema. */
export function joinRelayConfiguration(input: unknown, externalTokenFile?: string, testEnvironmentOrigin?: string, mirrorFile?: string, noticeFile?: string, internalEnrollment = false, mirrorRedisFile?: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Join relay configuration');
  const { issuer, privateKey, tencentOaTokenFile, authenticationOrigin, wecomCallback, ...rest } = input as Record<string, unknown>;
  const legacy = [issuer, privateKey, tencentOaTokenFile, authenticationOrigin];
  const useLegacy = legacy.some(value => value !== undefined);
  if (useLegacy && (rest.authentication !== undefined || !legacy.every(value => typeof value === 'string' && value.length > 0))) {
    throw new Error('Incomplete or mixed Join identity gateway configuration');
  }
  const configuration = parseRelayConfiguration({
    ...rest,
    ...(useLegacy ? { authentication: { issuer, privateKey, origin: authenticationOrigin, providers: ['tencentoa'] } } : {}),
  });
  const auth = configuration.authentication;
  const tokenFile = useLegacy ? tencentOaTokenFile : externalTokenFile;
  if (auth && (!auth.providers.includes('tencentoa') || typeof tokenFile !== 'string' || !isAbsolute(tokenFile))) {
    throw new Error('Join identity gateway requires a private Tencent OA token file');
  }
  let identity: IdentityProvider | undefined;
  let employeeDirectory: ((rtx: string, signal: AbortSignal) => Promise<unknown>) | undefined;
  const composition: RelayComposition = auth && typeof tokenFile === 'string' ? {
    ...(configuration.serverSelection ? { entryOrigin: joinEntryOrigin(auth.origin) } : {}),
    async createIdentity() {
      const plugin = await TencentOaServerPlugin.fromTokenFile(tokenFile);
      identity = { ...plugin.identityProvider(), preparePrincipal: createRtxLoginPreparation(() => employeeDirectory) };
      return { provider: identity, close: () => { identity = undefined; return plugin.close(); } };
    },
  } : {};
  const target = wecomCallback === undefined ? undefined : parseWeComCallbackTarget(wecomCallback);
  if (target && !configuration.hubNetwork) throw new Error('WeCom callback requires a Relay Hub network');
  if (noticeFile && (mirrorFile || !target || !isAbsolute(noticeFile))) throw new Error('WeCom single-chat notice requires one Hub callback and an absolute credential file');
  if (mirrorFile && !configuration.clusterFile) throw new Error('Store-and-forward requires Relay Redis');
  if (mirrorRedisFile && (!mirrorFile || !isAbsolute(mirrorRedisFile))) throw new Error('Dedicated recording Redis requires mirror mode and an absolute private configuration');
  if (mirrorFile && !configuration.tlsCertFile && !configuration.hubNetwork?.port) throw new Error('Store-and-forward requires an authenticated TLS listener');
  if(internalEnrollment&&(!configuration.hubNetwork?.port&&!configuration.tlsCertFile))throw Error('IP enrollment requires the direct TLS entrance');
  if(internalEnrollment&&!configuration.hubNetwork)throw Error('IP enrollment requires a Hub owner');
  composition.peerRequestPaths=[...(mirrorFile||noticeFile?[MIRROR_PATH+'/']:[]),...(internalEnrollment?[HUB_ENROLLMENT_PATH]:[])];
  if (target || testEnvironmentOrigin || mirrorFile || internalEnrollment) {
    composition.createIngress = async ({ hub, sharedRedis, openHubStream, authenticateEntryRequest, beginEntryAuthentication, listServers }) => {
      if (target && !openHubStream) throw new Error('WeCom callback requires a Relay Hub stream');
      const selection = {listServers,authenticateEntryRequest,beginEntryAuthentication};
      const recordingRedis = mirrorRedisFile ? await RelayRedis.connect(await readRelayRedisConfiguration(mirrorRedisFile)) : undefined;
      const identityStore = recordingRedis ?? sharedRedis;
      let mirror;
      try { mirror = mirrorFile ? await createMirrorIngress(mirrorFile, recordingRedis ?? sharedRedis, {...selection,
        ...(auth?{receiverEnrollment:{routes:configuration.routes,hub,relayOrigin:auth.origin,signingKey:auth.privateKey}}:{}),
        // Authentication sessions belong to shared Relay Redis, never the optional recording store.
        identityDirectory:identityStore && {
          knownPrincipals:()=>sharedRedis?.knownPrincipals()??Promise.resolve([]),
          read:(key:string)=>identityStore.read(key),
          evaluate:(script:string,keys:string[],args:(string|number)[])=>identityStore.evaluate(script,keys,args),
        },
      }) : undefined; }
      catch (error) { recordingRedis?.close(); throw error; }
      const forwarding = noticeFile ? await createForwardingIngress(noticeFile, sharedRedis,
        callback => createWeComCallbackIngress(target!, openHubStream!, callback),selection) : undefined;
      employeeDirectory = mirror?.employeeForRtx ?? forwarding?.employeeForRtx;
      const enrollment=internalEnrollment?createIpEnrollmentIngress(hub!,sharedRedis,undefined,[...(auth?[auth.origin]:[]),...configuration.routes.map(route=>route.origin)]):undefined;
      const handlers = [
        ...(enrollment?[enrollment]:[]),
        ...(mirror ? [mirror] : []),
        ...(forwarding ? [forwarding] : !mirror && target ? [createWeComCallbackIngress(target, openHubStream!)] : []),
        ...(testEnvironmentOrigin ? [createTestEnvironmentIngress(testEnvironmentOrigin, authenticateEntryRequest)] : []),
      ];
      const ingress = (request: IncomingMessage, response: ServerResponse) => handlers.some(handle => handle(request, response));
      ingress.close = async () => { employeeDirectory = undefined; await Promise.allSettled([mirror?.close?.(),forwarding?.close?.(),enrollment?.close?.()]); recordingRedis?.close(); };
      return ingress;
    };
  }
  return { configuration, composition, authenticateWebRequest: (request: Parameters<IdentityProvider['authenticate']>[0]) => identity?.authenticate(request) ?? null };
}

export async function readJoinRelayConfiguration(path: string) {
  const input = await readPrivateJson(path) as Record<string, unknown>;
  const hubId = process.env.JOIN_WECOM_CALLBACK_HUB_ID, origin = process.env.JOIN_WECOM_CALLBACK_ORIGIN;
  if ((hubId || origin) && input.wecomCallback !== undefined) throw new Error('Duplicate WeCom callback configuration');
  return joinRelayConfiguration({
    ...input,
    ...((hubId || origin) ? { wecomCallback: { hubId, origin } } : {}),
  }, process.env.JOIN_TENCENTOA_TOKEN_FILE, process.env.JOIN_TEST_ENVIRONMENT_UPSTREAM, process.env.JOIN_WECOM_MIRROR_FILE, process.env.JOIN_WECOM_NOTICE_FILE, process.env.JOIN_RELAY_INTERNAL_ENROLLMENT === '1', process.env.JOIN_WECOM_REDIS_FILE);
}
