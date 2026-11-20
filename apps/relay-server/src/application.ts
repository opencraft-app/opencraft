import { AssertionSigner, readPrivateJson, type IdentityProvider } from '@opencraft/identity-core/node';
import { createRelayServer, type RelayEntryIdentity, type RelayIngress, type RelayRoute } from './server.js';
import { createServer as createHttpsServer } from 'node:https';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Principal } from '@opencraft/identity-core';
import type { RelayServerDirectory } from './server.js';
import type { EntryOriginResolver } from './authentication.js';
import { readFile } from 'node:fs/promises';
import { createPrivateKey, createPublicKey, createHash } from 'node:crypto';
import { HubNetwork } from '@opencraft/hub-network/node';
import { HUB_CONTROL_PATH, HUB_DATA_PATH, publicOrigin } from '@opencraft/hub-network';
import { parseSelectionDefaults, parseServerPaths, type ServerPaths } from './selection.js';
import { RelayRedis, readRelayRedisConfiguration } from './redis.js';
import { RedisRelayCluster } from './cluster.js';
import type { RelayHub } from './cluster-port.js';

export interface RelayAuthenticationConfiguration {
  issuer: string;
  privateKey: string;
  origin: string;
  providers: string[];
}
export interface RelayConfiguration {
  schemaVersion: 1;
  host: '127.0.0.1' | '0.0.0.0';
  port: number;
  routes: { instanceId: string; origin: string; credential: string; name?: string }[];
  authentication?: RelayAuthenticationConfiguration;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  tlsTermination?: 'trusted-proxy';
  serverSelection?: boolean;
  serverSelectionDefaultsFile?: string;
  serverPaths?: ServerPaths;
  clusterFile?: string;
  hubNetwork?: { stateFile: string; operatorCredentialFile: string; caFile?: string; tlsCertFile?: string; tlsKeyFile?: string; port?: number };
}
/** Trusted server composition, never a module named by browser or private JSON input. */
export interface RelayIdentityAdapter {
  provider: IdentityProvider;
  close(): void | Promise<void>;
}
export type OpenRelayHubStream = (target: { hubId: string; origin: string }, signal: AbortSignal) => Promise<Duplex>;

export interface RelayComposition {
  peerRequestPaths?: readonly string[];
  createIngress?: (services: { beginEntryAuthentication: (request: IncomingMessage, response: ServerResponse) => Promise<void>; hub?: RelayHub; sharedRedis?: RelayRedis; openHubStream?: OpenRelayHubStream; listServers: (principal: Principal) => Promise<RelayServerDirectory>; authenticateEntryRequest: (request: IncomingMessage) => Promise<RelayEntryIdentity | null> }) => RelayIngress | Promise<RelayIngress>;
  entryOrigin?: EntryOriginResolver;
  createIdentity?: (configuration: Readonly<RelayAuthenticationConfiguration>) => Promise<RelayIdentityAdapter>;
  build?: { sourceRevision: string | null; buildId: string | null };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function only(value: Record<string, unknown>, keys: readonly string[]) { return Object.keys(value).every(key => keys.includes(key)); }
function port(value: unknown) { return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535; }
function file(value: unknown) { return typeof value === 'string' && value.startsWith('/') && !value.includes('\0'); }

export function parseRelayConfiguration(value: unknown): RelayConfiguration {
  if (!record(value) || value.schemaVersion !== 1 || !port(value.port) || !['127.0.0.1', '0.0.0.0'].includes(String(value.host)) || !Array.isArray(value.routes)
    || !only(value, ['schemaVersion', 'authentication', 'port', 'host', 'routes', 'tlsCertFile', 'tlsKeyFile', 'tlsTermination', 'hubNetwork', 'serverSelection', 'serverSelectionDefaultsFile', 'serverPaths', 'clusterFile'])) throw new Error('Invalid relay configuration');
  if (value.clusterFile !== undefined && (!file(value.clusterFile) || !value.hubNetwork)) throw new Error('Redis relay requires a private cluster file and initial Hub identity');
  if (value.serverSelection !== undefined && typeof value.serverSelection !== 'boolean') throw new Error('Invalid server selection policy');
  if (value.serverSelectionDefaultsFile !== undefined && (value.serverSelection !== true || !file(value.serverSelectionDefaultsFile))) throw new Error('Invalid selection defaults configuration');
  if (value.serverPaths !== undefined) {
    if (value.serverSelection !== true) throw new Error('Server paths require server selection');
    parseServerPaths(value.serverPaths);
  }
  if (value.tlsTermination !== undefined && value.tlsTermination !== 'trusted-proxy') throw new Error('Invalid TLS termination policy');
  if ((value.tlsCertFile !== undefined || value.tlsKeyFile !== undefined) && (!file(value.tlsCertFile) || !file(value.tlsKeyFile))) throw new Error('Incomplete TLS configuration');
  if (!value.tlsCertFile && !(value.host === '127.0.0.1' || value.tlsTermination === 'trusted-proxy')) throw new Error('Public relay requires TLS or explicit trusted TLS termination');
  const auth = value.authentication;
  if (auth !== undefined) {
    if (!record(auth) || !only(auth, ['issuer', 'privateKey', 'origin', 'providers']) || typeof auth.issuer !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(auth.issuer)
      || typeof auth.privateKey !== 'string' || !Array.isArray(auth.providers) || !auth.providers.length || auth.providers.length > 64
      || auth.providers.some(provider => typeof provider !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(provider)) || new Set(auth.providers).size !== auth.providers.length) throw new Error('Invalid relay authentication configuration');
    publicOrigin(auth.origin);
    if (createPrivateKey(auth.privateKey).asymmetricKeyType !== 'ed25519') throw new Error('Relay assertions require Ed25519');
  }
  if (!auth && value.routes.length) throw new Error('Routes require an identity gateway');
  for (const route of value.routes) {
    if (!record(route) || !only(route, ['instanceId', 'name', 'origin', 'credential']) || typeof route.instanceId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(route.instanceId)
      || typeof route.credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(route.credential)
      || (route.name !== undefined && (typeof route.name !== 'string' || !route.name.trim() || route.name.length > 128))) throw new Error('Invalid route');
    publicOrigin(route.origin);
  }
  const network = value.hubNetwork;
  if (network !== undefined) {
    if (!record(network) || !only(network, ['stateFile', 'operatorCredentialFile', 'caFile', 'tlsCertFile', 'tlsKeyFile', 'port']) || !file(network.stateFile) || !file(network.operatorCredentialFile)
      || (network.caFile !== undefined && !file(network.caFile)) || (network.port !== undefined && (!port(network.port) || network.port === value.port || !file(network.tlsCertFile) || !file(network.tlsKeyFile)))
      || ((network.tlsCertFile !== undefined || network.tlsKeyFile !== undefined) && (!file(network.tlsCertFile) || !file(network.tlsKeyFile)))) throw new Error('Invalid Hub configuration');
  }
  return value as unknown as RelayConfiguration;
}

async function listen(server: Server, port: number, host: string) {
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', failed); resolve(); };
    server.once('error', failed); server.once('listening', ready); server.listen(port, host);
  });
}
async function closeServer(server: Server | undefined) {
  if (!server) return;
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
}

/** Own all resources from acquisition through startup rollback and idempotent shutdown. */
export async function startRelayApplication(input: unknown, composition: RelayComposition = {}) {
  const config = parseRelayConfiguration(input), auth = config.authentication;
  if (auth && !composition.createIdentity) throw new Error('Configured identity gateway requires a server identity adapter');
  if (!auth && composition.createIdentity) throw new Error('Identity adapter requires explicit gateway configuration');
  const selectionDefaults = config.serverSelectionDefaultsFile ? parseSelectionDefaults(await readPrivateJson(config.serverSelectionDefaultsFile)) : undefined;
  let identity: RelayIdentityAdapter | undefined, hub: HubNetwork | undefined;
  let redis: RelayRedis | undefined, cluster: RedisRelayCluster | undefined;
  let app: ReturnType<typeof createRelayServer> | undefined, listener: Server | undefined, peerListener: Server | undefined;
  let ingress: RelayIngress | undefined;
  let closing: Promise<void> | undefined;
  let draining: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    // Retire forwarding/upgrade streams before listeners and identity credentials.
    // allSettled ensures one failing disposer cannot leak another resource or lock.
    const failures: unknown[] = [];
    try { await app?.close(); } catch (error) { failures.push(error); }
    try { await ingress?.close?.(); } catch (error) { failures.push(error); }
    try { hub?.close(); } catch (error) { failures.push(error); }
    for (const result of await Promise.allSettled([cluster?.close(), closeServer(peerListener), listener !== app?.server ? closeServer(listener) : undefined])) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    try { await identity?.close(); } catch (error) { failures.push(error); }
    if (!cluster) redis?.close();
    if (failures.length) throw new AggregateError(failures, 'Relay shutdown failed');
  })();
  const drainAndClose = (options: { propagationMs?: number; timeoutMs?: number } = {}) => {
    const propagationMs = options.propagationMs ?? 5_000, timeoutMs = options.timeoutMs ?? 45_000;
    if (![propagationMs, timeoutMs].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 600_000)) throw new Error('Invalid relay drain budget');
    if (closing) return closing;
    return draining ??= (async () => {
      app?.beginDrain();
      // The application, peer links and Redis remain alive during endpoint propagation.
      if (propagationMs) await new Promise(resolve => setTimeout(resolve, propagationMs));
      app?.stopAdmission();
      const deadline = performance.now() + timeoutMs;
      try {
        while (!closing) {
          app?.handoffControls();
          if (!(app?.activeRequests() || app?.activeStreams() || cluster?.activeStreams() || hub?.activeStreams()) || performance.now() >= deadline) break;
          await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - performance.now()))));
        }
      } finally { await close(); }
    })();
  };
  try {
    if (auth) {
      identity = await composition.createIdentity!(auth);
      if (!identity || typeof identity.close !== 'function' || typeof identity.provider?.authenticate !== 'function') throw new Error('Invalid server identity adapter');
      const adapter = identity, provider = adapter.provider;
      identity = { close: () => adapter.close(), provider: {
        authenticate: request => { const principal = provider.authenticate(request); return principal && auth.providers.includes(principal.provider) ? principal : null; },
        ...(provider.preparePrincipal ? { preparePrincipal: principal => provider.preparePrincipal!(principal) } : {}),
        ...(provider.trustedOrigin ? { trustedOrigin: request => provider.trustedOrigin!(request) } : {}),
        ...(provider.isCurrent ? { isCurrent: principal => auth.providers.includes(principal.provider) && provider.isCurrent!(principal) } : {}),
      } };
    }
    const provider = identity?.provider;
    const routes: RelayRoute[] = config.routes.map(route => ({ ...route, ...(route.name ? { name: route.name.trim() } : {}), identityProvider: provider!,
      signer: new AssertionSigner({ issuer: auth!.issuer, instanceId: route.instanceId, origin: route.origin }, auth!.privateKey) }));
    const authority = auth ? { issuer: auth.issuer, publicKey: createPublicKey(auth.privateKey).export({ format: 'pem', type: 'spki' }).toString(), providers: auth.providers } : undefined;
    const network = config.hubNetwork;
    const operator = network ? await readPrivateJson(network.operatorCredentialFile) : null;
    const operatorCredential = record(operator) ? operator.credential : null;
    if (network && (typeof operatorCredential !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(operatorCredential))) throw new Error('Invalid private operator credential');
    if (config.clusterFile) {
      redis = await RelayRedis.connect(await readRelayRedisConfiguration(config.clusterFile));
      cluster = new RedisRelayCluster(redis, { nodeId: process.env.OPENCRAFT_RELAY_NODE_ID ?? '', advertiseHost: process.env.OPENCRAFT_RELAY_ADVERTISE_HOST ?? '',
        publicPort: config.port, stateFile: network!.stateFile, configurationHash: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
        ...(authority ? { authority } : {}), ...(network!.caFile ? { ca: await readFile(network!.caFile, 'utf8') } : {}) });
    } else hub = network ? new HubNetwork(network.stateFile, { ...(authority ? { authority } : {}), localService: false, ...(network.caFile ? { ca: await readFile(network.caFile, 'utf8') } : {}) }) : undefined;
    const relayHub = cluster?.hub ?? hub;
    const openHubStream: OpenRelayHubStream | undefined = relayHub && (async ({ hubId, origin }, signal) => {
      signal.throwIfAborted();
      if (!relayHub.routes().some(route => route.service.hubId === hubId && route.service.origin === origin)) {
        throw new Error('Relay Hub service unavailable');
      }
      return relayHub.open(hubId, undefined, signal);
    });
    ingress = await composition.createIngress?.({ beginEntryAuthentication: (request, response) => app!.beginEntryAuthentication(request, response), hub: relayHub, sharedRedis: redis, openHubStream, listServers: principal => app!.listServers(principal), authenticateEntryRequest: request => app!.authenticateEntryRequest(request) });
    app = createRelayServer(routes, { ingress, serverSelection: config.serverSelection === true, selectionDefaults, serverPaths: config.serverPaths, ...(provider ? { authentication: { origin: auth!.origin, provider } } : {}),
      ...(cluster ? { cluster } : {}),
      ...(relayHub ? { hub: relayHub, operator: { credential: operatorCredential as string }, networkRoute: service => {
        if (!authority || !provider || JSON.stringify(service.authority) !== JSON.stringify(authority)) return null;
        return { instanceId: service.hubId, hubId: service.hubId, origin: service.origin, credential: '', identityProvider: provider,
          signer: new AssertionSigner({ issuer: auth!.issuer, instanceId: service.hubId, origin: service.origin }, auth!.privateKey) };
      } } : {}), entryOrigin: composition.entryOrigin, build: composition.build });
    listener = config.tlsCertFile ? createHttpsServer({ cert: await readFile(config.tlsCertFile), key: await readFile(config.tlsKeyFile!) }) : app.server;
    if (listener !== app.server) {
      listener.maxConnections = 16_384; listener.headersTimeout = 15_000; listener.requestTimeout = 600_000; listener.maxRequestsPerSocket = 1000;
      listener.on('request', (req, res) => app!.server.emit('request', req, res));
      listener.on('upgrade', (req, socket, head) => app!.server.emit('upgrade', req, socket, head));
    }
    if (network?.port) {
      peerListener = createHttpsServer({ cert: await readFile(network.tlsCertFile!), key: await readFile(network.tlsKeyFile!) }, (req, res) => {
        if (composition.peerRequestPaths?.some(path => req.url?.startsWith(path))) { app!.server.emit('request', req, res); return; }
        res.writeHead(404); res.end();
      });
      peerListener.on('upgrade', (req, socket, head) => {
        if (![HUB_CONTROL_PATH, HUB_DATA_PATH].includes(req.url ?? '')) { socket.destroy(); return; }
        app!.server.emit('upgrade', req, socket, head);
      });
      await listen(peerListener, network.port, '0.0.0.0');
    }
    await cluster?.start();
    await listen(listener, config.port, config.host);
    hub?.start(config.port);
    return { server: listener, hub, close, drainAndClose };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Relay startup and rollback failed'); }
    throw error;
  }
}

export async function runRelayCli(options: RelayComposition & { loadConfiguration?: (path: string) => Promise<unknown> } = {}) {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || extra.length) throw new Error('Usage: opencraft-relay /absolute/private-config.json');
  const app = await startRelayApplication(await (options.loadConfiguration ?? readPrivateJson)(path), { ...options,
    build: options.build ?? { sourceRevision: process.env.OPENCRAFT_RELAY_SOURCE_REVISION ?? null, buildId: process.env.OPENCRAFT_RELAY_BUILD_ID ?? null } });
  console.log('OpenCraft relay ready');
  const shutdown = () => { process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown); void app.drainAndClose().catch(() => { console.error('Relay shutdown failed'); process.exitCode = 1; }); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  return app;
}
