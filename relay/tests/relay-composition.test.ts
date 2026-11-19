import test from 'node:test';
// The installed post-deploy worker already schedules this composition entry.
import './grasp-proxy.test.js';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request, createServer, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes, createHash, createCipheriv } from 'node:crypto';
import { joinRelayConfiguration } from "../relay-composition";
import { startRelayApplication } from "../../apps/relay-server/src/application";

test('Join explicitly translates private configuration and preserves IOA verification', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'join-relay-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const token = Buffer.alloc(32, 97), file = join(dir, 'ioa-token'); await writeFile(file, token, { mode: 0o600 });
  const pair = generateKeyPairSync('ed25519');
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as {port:number}).port; await new Promise<void>(r => server.close(() => r()));
  const input = { schemaVersion: 1, host: '127.0.0.1', port, issuer: 'join-fixture', privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    authenticationOrigin: 'http://login.test', tencentOaTokenFile: file, routes: [{ instanceId: 'team', origin: 'http://team.test', credential: randomBytes(32).toString('base64url') }] };
  const { configuration, composition } = joinRelayConfiguration(input);
  assert.deepEqual(configuration.authentication?.providers, ['tencentoa']);
  assert.ok(!Object.hasOwn(configuration, 'tencentOaTokenFile'));
  assert.equal(joinRelayConfiguration({ ...input, serverSelection: true, serverSelectionDefaultsFile: '/private/defaults.json' }).configuration.serverSelectionDefaultsFile, '/private/defaults.json');
  assert.equal(joinRelayConfiguration({ ...input, serverSelection: true }).composition.entryOrigin!({ headers: { host: 'join.woa.com' } } as any), 'http://join.woa.com');
  assert.equal(composition.entryOrigin, undefined, 'direct legacy routes retain their fixed authentication gateway');
  assert.deepEqual(joinRelayConfiguration({ ...input, serverSelection: true, serverPaths: { aliases: { team: 'research' } } }).configuration.serverPaths, { aliases: { team: 'research' } });
  const clusterFile = '/private/relay-cluster.json';
  assert.throws(() => joinRelayConfiguration({ ...input, clusterFile }), /initial Hub identity/);
  const hubNetwork = { stateFile: '/private/hub.json', operatorCredentialFile: '/private/operator.json' };
  assert.equal(joinRelayConfiguration({ ...input, hubNetwork, clusterFile }).configuration.clusterFile, clusterFile);
  const { tencentOaTokenFile, issuer, privateKey, authenticationOrigin, ...coreInput } = input;
  const normalized = { ...coreInput, authentication: { issuer, privateKey, origin: authenticationOrigin, providers: ['tencentoa'] } };
  assert.throws(() => joinRelayConfiguration(normalized), /private Tencent OA token file/);
  assert.deepEqual(joinRelayConfiguration(normalized, tencentOaTokenFile).configuration, configuration);
  const app = await startRelayApplication(configuration, composition); t.after(() => app.close());
  const get = (headers: Record<string, string>, path = '/') => new Promise<{status:number;headers:IncomingHttpHeaders}>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers: { host: 'team.test', ...headers } }, res => { res.resume(); res.on('end', () => resolve({status:res.statusCode!,headers:res.headers})); }); req.once('error', reject); req.end();
  });
  assert.equal((await get({})).status, 401);
  const timestamp = String(Math.floor(Date.now() / 1000)), sequence = 'composition-fixture';
  const header = Buffer.from(JSON.stringify({ alg: 'dir', enc: 'A256GCM' })).toString('base64url');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', token, iv); cipher.setAAD(Buffer.from(header));
  const body = Buffer.concat([cipher.update(JSON.stringify({ LoginName: 'fixture.employee', StaffId: 123, Expiration: new Date(Date.now() + 3600_000).toISOString() })), cipher.final()]);
  const headers = { timestamp, 'x-rio-seq': sequence,
    signature: createHash('sha256').update(timestamp + token.toString() + sequence + ',,,' + timestamp).digest('hex').toUpperCase(),
    'x-tai-identity': [header, '', iv.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.') };
  const start = await get({accept:'text/html'}); assert.equal(start.status,303);
  const login = new URL(start.headers.location!);
  const verified = await get({...headers,host:login.host},login.pathname+login.search); assert.equal(verified.status,303);
  const callback = new URL(verified.headers.location!);
  const session = await get({cookie:start.headers['set-cookie']![0]!.split(';')[0]!},callback.pathname+callback.search); assert.equal(session.status,303);
  const cookie = session.headers['set-cookie']!.find(c=>c.startsWith('opencraft-relay-session='))!.split(';')[0]!;
  assert.equal((await get({cookie})).status,503,'verified identity reaches tunnel acquisition without inventing a target');
  const retry = await get({accept:'text/html'}), failed = new URL(retry.headers.location!);
  assert.equal((await get({...headers,host:failed.host,signature:'invalid'},failed.pathname+failed.search)).status,401);
  for (const bad of [{ ...input, tencentOaTokenFile: undefined }, { ...input, authentication: {} }, { ...input, privateKey: '' }]) assert.throws(() => joinRelayConfiguration(bad));
  const transit = joinRelayConfiguration({ schemaVersion: 1, host: '127.0.0.1', port, routes: [] });
  assert.equal(transit.composition.createIdentity, undefined);
});
