import { consumeWorkspaceExecutionGrant, workspaceGrantField } from '@opencraft/sandbox-node/workspace-execution-channel';
import type { DuplexTransport } from '@opencraft/appserver-client/transport';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, chmod, symlink, readFile, lstat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ssh2 from 'ssh2';
import { createIoaCapabilities, parseIoaCapabilities } from '../../plugins/tencentoa/src/instance-capabilities.mjs';
import { createEmployeeCliAccess } from '../../plugins/tencentoa/src/employee-cli-access.mjs';
import { joinIdentityComposition } from '../../identity.mjs';
import { GIT_CREDENTIALS_PATH } from '../../plugins/tencentoa/src/git-credentials-contract';
import { GongfengExecutionCredentials } from '../../gongfeng-mcp';
import { EmployeeGitVaultStore } from '../../../../scripts/employee-git-vault-store';
import { createSshHttpIngress } from '../../../../plugins/ssh-http-ingress/src/index.mjs';
import { OpenCraftHostStateDatabase } from '../../../../apps/opencraft-daemon/src/opencraft-host-state-database';
import { ExecutionLeaseStore } from '../../../../apps/opencraft-daemon/src/execution-lease-store';
import { installRuntimePlugin } from '../../runtime-plugins/store.mjs';
import { createHash } from 'node:crypto';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ioa-instance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const actor = { id: 'employee-100', kind: 'human', enabled: true, generation: 1 };
  let admitted = true, revision = 0;
  const principal = { provider: 'tencentoa', subject: '100', displayName: 'alice', attributes: { loginName: 'alice' }, expiresAt: Date.now() + 60_000 };
  const resolveIdentity = (req: any) => req.headers['x-test-user'] ? { ...principal, subject: req.headers['x-test-user'] } : null;
  const access = {
    role: (p: any) => admitted && p?.provider === 'tencentoa' ? 'member' : null,
    admissionStatus: (req: any) => !resolveIdentity(req) ? 401 : admitted ? 204 : 403,
    admitsActor: (id: string) => admitted && id === actor.id,
    store: { revocationRevision: () => revision, actorMembership: () => ({ role: 'member' }) },
  };
  const actors = { findHuman: (p: any) => p.provider === 'tencentoa' && p.subject === '100' ? actor : null,
    bindings: () => [{ provider: 'tencentoa', subject: '100' }], onHumanRegistered: () => () => {}, registerHumanReservationResolver: () => () => {} };
  const context = { dataDirectory: directory, actors, getInstanceAccess: () => access, resolveIdentity,
    hubAuthority: { providers: ['tencentoa'] }, machineIdentity: { machineId: 'fixture' }, sshIngressEnabled: true };
  const revoke = () => { admitted = false; revision++; };
  return { directory, context, actor, access, revoke, readmit: () => { admitted = true; }, setRevision: (value: number) => { revision = value; } };
}
async function seedCli(directory: string) {
  const path = join(directory, 'employee-ssh-credentials.sqlite'), pair = ssh2.utils.generateKeyPairSync('ed25519');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE employee_cli_keys(id TEXT,actor_id TEXT,subject TEXT,username TEXT,generation INTEGER,membership_revision INTEGER,public_key TEXT,revoked_at INTEGER);
    CREATE TABLE employee_ssh_credentials(private_key TEXT); INSERT INTO employee_ssh_credentials VALUES('private-fixture-not-to-be-read');`);
  db.prepare('INSERT INTO employee_cli_keys VALUES(?,?,?,?,?,?,?,NULL)').run('k', 'employee-100', '100', 'alice', 1, 0, pair.public);
  db.close(); await chmod(path, 0o600);
  return { path, pair, blob: ssh2.utils.parseKey(pair.public).getPublicSSH() };
}

test('IOA feature data is strict, default enabled and cannot name code or credentials', () => {
  assert.deepEqual(parseIoaCapabilities({ schemaVersion: 1 }), { employeeGit: true, gongfeng: true, employeeCli: true });
  assert.equal(parseIoaCapabilities({ schemaVersion: 1, employeeCli: false }).employeeCli, false);
  for (const value of [null, [], {}, { schemaVersion: 2 }, { schemaVersion: 1, employeeGit: 'true' },
    { schemaVersion: 1, module: '/tmp/arbitrary.mjs' }, { schemaVersion: 1, token: 'private' }]) assert.throws(() => parseIoaCapabilities(value));
});

test('compiled product routes employee Git, scopes accounts, preserves vault CAS and account defaults across restart', async t => {
  const f = await fixture(t); const cli = await seedCli(f.directory); let identity: any;
  let server: ReturnType<typeof createServer> | undefined, started = false;
  const start = async () => {
    identity = await joinIdentityComposition().createIdentity(f.context);
    assert.deepEqual(identity.capabilityProviders.map((p: any) => p.id), ['gongfeng']);
    assert.deepEqual(identity.sshAccess.publicKeys('alice'), started ? [] : [cli.pair.public]); started = true;
    server = createServer((req, res) => { if (!identity.service.handle(req, res)) res.writeHead(404).end(); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return 'http://127.0.0.1:' + (server.address() as any).port;
  };
  const stop = async () => { if (server) { server.close(); await once(server, 'close'); server = undefined; } await identity.close(); };
  t.after(stop);
  let origin = await start();
  const call = async (user = '100', input?: any, extra: Record<string, string> = {}) => {
    const response = await fetch(origin + GIT_CREDENTIALS_PATH, { method: input ? 'POST' : 'GET', headers: {
      ...(user ? { 'x-test-user': user } : {}), 'x-opencraft-account-scope': 'tencentoa:' + user,
      ...(input ? { 'content-type': 'application/json', origin } : {}), ...extra,
    }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, body: await response.json() as any };
  };
  assert.equal((await call()).status, 200);
  assert.equal((await call('')).status, 401);
  assert.equal((await call('100', undefined, { 'x-opencraft-account-scope': 'tencentoa:200' })).status, 409);
  const input = { action: 'save', host: 'git.woa.com', revision: 0, username: 'alice', name: 'Alice', email: 'alice@example.test' };
  assert.equal((await call('100', input)).status, 200);
  assert.equal((await call('100', input)).status, 409);
  assert.equal((await call('200')).body.hosts['git.woa.com'].revision, 0);
  assert.equal((await call('100', { action: 'save-mcp', host: 'git.woa.com', revision: 0, token: 'tai_fixture-private' })).status, 200);
  const status = await call(); assert.equal(status.body.gongfengMcp.configured, true);
  assert(!JSON.stringify(status.body).includes('tai_fixture-private'));
  const defaults = await fetch(origin + '/__opencraft_enterprise_identity/model-defaults?hostId=fixture', {
    headers: { 'x-test-user': '100', 'x-opencraft-account-scope': 'tencentoa:100' },
  }); assert.equal(defaults.status, 200);
  f.revoke(); assert.equal((await call()).status, 401); f.readmit();
  await stop(); origin = await start();
  assert.equal((await call()).body.hosts['git.woa.com'].revision, 1);
  assert.equal((await call()).body.gongfengMcp.configured, true);
});

test('revocation while receiving a Git mutation refuses the write', async t => {
  const f = await fixture(t); const identity = await joinIdentityComposition().createIdentity(f.context);
  const server = createServer((req, res) => { if (!identity.service.handle(req, res)) res.writeHead(404).end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.close(); await once(server, 'close'); await identity.close(); });
  const received = once(server, 'request');
  const req = request({ hostname: '127.0.0.1', port: (server.address() as any).port, path: GIT_CREDENTIALS_PATH, method: 'POST',
    headers: { 'x-test-user': '100', 'x-opencraft-account-scope': 'tencentoa:100', 'content-type': 'application/json' } });
  const response = new Promise<number>((resolve, reject) => { req.on('response', res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); }); req.on('error', reject); });
  req.flushHeaders(); await received; f.revoke();
  req.end(JSON.stringify({ action: 'save-mcp', host: 'git.woa.com', revision: 0, token: 'tai_never-written' }));
  assert.equal(await response, 401);
  f.readmit();
  const vault = new EmployeeGitVaultStore(f.directory); try { assert.equal(vault.readSecret('tencentoa:100', 'gongfeng-mcp').secret, null); } finally { vault.close(); }
});

test('CLI public-key adapter reads existing data without migration and revalidates key/generation/membership immediately', async t => {
  const f = await fixture(t), seeded = await seedCli(f.directory), before = await readFile(seeded.path);
  const access = createEmployeeCliAccess({ path: seeded.path, actors: f.context.actors, getAccess: f.context.getInstanceAccess });
  t.after(() => access.close());
  assert.deepEqual(access.publicKeys('alice'), [seeded.pair.public]);
  assert.equal(access.authorize('alice', Buffer.from('wrong')), null);
  const authorization = access.authorize('alice', seeded.blob)!; assert(authorization.isCurrent());
  assert.equal(authorization.submissionContext.actorContext.actorId, f.actor.id);
  assert.deepEqual(await readFile(seeded.path), before, 'public-key reads do not migrate/rewrite data');
  const db = new DatabaseSync(seeded.path); t.after(() => db.close());
  db.exec('UPDATE employee_cli_keys SET revoked_at=1'); assert.equal(authorization.isCurrent(), false);
  db.exec('UPDATE employee_cli_keys SET revoked_at=NULL'); f.actor.generation++; assert.equal(access.authorize('alice', seeded.blob), null);
  f.actor.generation--; f.revoke(); f.readmit(); assert.equal(access.authorize('alice', seeded.blob), null);
  f.setRevision(0); assert(access.authorize('alice', seeded.blob));
  db.prepare('INSERT INTO employee_cli_keys VALUES(?,?,?,?,?,?,?,NULL)').run('other', 'other', '200', 'alice', 1, 0, seeded.pair.public);
  assert.deepEqual(access.publicKeys('alice'), [], 'ambiguous enterprise identity fails closed');
  access.close(); assert.equal(authorization.isCurrent(), false);
});

test('missing, corrupt, insecure or symlink CLI stores deny only employee SSH without initialization', async t => {
  const f = await fixture(t); const path = join(f.directory, 'employee-ssh-credentials.sqlite');
  const access = createEmployeeCliAccess({ path, actors: f.context.actors, getAccess: f.context.getInstanceAccess });
  assert.deepEqual(access.publicKeys('alice'), []);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  await writeFile(path, 'broken', { mode: 0o600 }); assert.deepEqual(access.publicKeys('alice'), []);
  await rm(path); const seeded = await seedCli(f.directory);
  await chmod(path, 0o644); assert.deepEqual(access.publicKeys('alice'), []);
  await chmod(path, 0o600); const alias = path + '.link'; await symlink(path, alias);
  assert.deepEqual(createEmployeeCliAccess({ path: alias, actors: f.context.actors, getAccess: f.context.getInstanceAccess }).publicKeys('alice'), []);
  assert.deepEqual(access.publicKeys('alice'), [seeded.pair.public]); access.close();
});

test('private feature data disables optional capabilities and malformed data cannot enable shared SSH', async t => {
  const f = await fixture(t); await seedCli(f.directory);
  const vault = new EmployeeGitVaultStore(f.directory); t.after(() => vault.close()); const diagnostics: unknown[] = [];
  const configure = async (bytes: string) => { await writeFile(join(f.directory, 'ioa-capabilities.json'), bytes, { mode: 0o600 });
    return createIoaCapabilities(f.context, { vault, onDiagnostic: (x: unknown) => diagnostics.push(x) }); };
  for (const bytes of ['{', JSON.stringify({ schemaVersion: 1, module: 'private-not-logged' }),
    JSON.stringify({ schemaVersion: 1, employeeGit: false, gongfeng: false, employeeCli: false })]) {
    const service = await configure(bytes); assert.equal(service.gitCredentials, undefined); assert.deepEqual(service.capabilityProviders, []);
    assert.deepEqual(service.sshAccess!.publicKeys('alice'), []); assert.equal(service.sshAccess!.authorize('alice', Buffer.from('x')), null); service.close();
  }
  assert(!JSON.stringify(diagnostics).includes('private-not-logged'));
  const service = await configure('{"schemaVersion":1}'); assert(service.gitCredentials); assert.equal(service.capabilityProviders.length, 1);
  service.close(); assert.deepEqual(service.sshAccess!.publicKeys('alice'), []);
});

test('optional packages cannot shadow the IOA credential route; invalid feature data leaves identity/defaults usable', async t => {
  const f = await fixture(t), { mkdir } = await import('node:fs/promises');
  const source = join(f.directory, 'package'); await mkdir(source);
  const code = Buffer.from('globalThis.__ioaUnexpectedImport=true;export async function activate(){return{handle(){},close(){}}}');
  await writeFile(join(source, 'gateway.mjs'), code);
  await writeFile(join(source, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'test.credentials-shadow', version: '1', hostApi: 1,
    nodeMajor: 26, sourceRevision: 'a'.repeat(40), roles: { gateway: { entry: 'gateway.mjs', routes: [{ path: GIT_CREDENTIALS_PATH, methods: ['GET'] }] } },
    files: [{ path: 'gateway.mjs', size: code.length, sha256: createHash('sha256').update(code).digest('hex') }] }));
  await installRuntimePlugin(source, join(f.directory, 'runtime-plugins'), { enable: true });
  await writeFile(join(f.directory, 'ioa-capabilities.json'), '{invalid', { mode: 0o600 });
  const identity = await joinIdentityComposition().createIdentity(f.context);
  const server = createServer((req, res) => { if (!identity.service.handle(req, res)) res.writeHead(404).end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.close(); await once(server, 'close'); await identity.close(); });
  const origin = 'http://127.0.0.1:' + (server.address() as any).port;
  const headers = { 'x-test-user': '100', 'x-opencraft-account-scope': 'tencentoa:100' };
  assert.equal((globalThis as any).__ioaUnexpectedImport, undefined);
  assert.equal((await fetch(origin + GIT_CREDENTIALS_PATH, { headers })).status, 503);
  assert.equal((await fetch(origin + '/__opencraft_enterprise_identity/session', { headers })).status, 200);
  assert.equal((await fetch(origin + '/__opencraft_enterprise_identity/model-defaults?hostId=fixture', { headers })).status, 200);
  assert.deepEqual(identity.capabilityProviders, []);
});

test('compiled IOA CLI adapter authenticates real SSH and terminates the session after key removal', { timeout: 10_000 }, async t => {
  const f = await fixture(t), seeded = await seedCli(f.directory);
  const access = createEmployeeCliAccess({ path: seeded.path, actors: f.context.actors, getAccess: f.context.getInstanceAccess });
  const host = ssh2.utils.generateKeyPairSync('ed25519');
  const http = createServer((_req, res) => res.end('core')); http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const ingress = createSshHttpIngress({ hostKey: host.private, authorizedKeys: { operator: [host.public] }, httpPort: (http.address() as any).port, codexPort: 1,
    resolveAuthorizedKeys: access.publicKeys, authorizeSession: access.authorize, createNativeSession: async () => ({ port: 1, close: async () => {} }) });
  const address = await ingress.listen({ port: 0 }); const clients: ssh2.Client[] = [];
  t.after(async () => { for (const c of clients) c.destroy(); await ingress.close(); access.close(); http.close(); await once(http, 'close'); });
  const connect = async (username: string, privateKey = seeded.pair.private) => {
    const client = new ssh2.Client(); clients.push(client); client.on('error', () => {});
    const ready = once(client, 'ready'); client.connect({ host: '127.0.0.1', port: address.port, username, privateKey, readyTimeout: 1500 }); await ready; return client;
  };
  await assert.rejects(connect('other'), /authentication/);
  const client = await connect('alice'); const closed = once(client, 'close');
  const db = new DatabaseSync(seeded.path); db.exec('UPDATE employee_cli_keys SET revoked_at=1'); db.close(); await closed;
  await assert.rejects(connect('alice'), /authentication/);
});

test('Gongfeng credential lookup requires exact execution and current employee authority without creating stores', async t => {
  const f = await fixture(t), vault = new EmployeeGitVaultStore(f.directory); t.after(() => vault.close());
  const resolver = new GongfengExecutionCredentials(f.directory, 'fixture', vault, () => true);
  assert.equal(resolver.resolve({ serverId: 'server:other:codex', threadId: 't', execution: { inputId: 'i' } } as any, true), null);
  assert.equal(resolver.resolve({ serverId: 'server:fixture:codex', threadId: 't', execution: { inputId: 'i' } } as any, true), null);
  await assert.rejects(readFile(join(f.directory, 'codex/opencraft-host-state.sqlite')), { code: 'ENOENT' });
  const { mkdir } = await import('node:fs/promises'); await mkdir(join(f.directory, 'codex'));
  const owner = new OpenCraftHostStateDatabase(join(f.directory, 'codex')); t.after(() => owner.close());
  const leases = new ExecutionLeaseStore(owner.database);
  leases.capture('t', 'i', { principal: { provider: 'tencentoa', subject: '100' }, ownership: 'human' });
  const executionId = leases.begin('t', 'i');
  vault.writeSecret('tencentoa:100', 'gongfeng-mcp', 0, 'tai_fixture-only');
  const bound = new GongfengExecutionCredentials(f.directory, 'fixture', vault, principal =>
    !!f.context.actors.findHuman(principal)?.enabled && f.access.admitsActor(f.actor.id));
  const session = { serverId: 'server:fixture:codex', threadId: 't', execution: { inputId: 'i', executionId } } as any;
  assert.equal(bound.resolve(session, true), null, 'pending input cannot invoke tools');
  leases.started('t', 'turn', 'i', 'engine');
  assert.equal(bound.resolve(session, true)?.token, 'tai_fixture-only');
  assert.equal(bound.resolve({ ...session, execution: { ...session.execution, executionId: 'wrong' } }, true), null);
  f.revoke(); assert.equal(bound.resolve(session, true), null); f.readmit();
  leases.finished('t', 'turn'); assert.equal(bound.resolve(session, true), null);
});

test('formal identity owns ordinary workspace lifecycle and never restores fallback after close',async t=>{
 const f=await fixture(t),composition=joinIdentityComposition();
 const identity=await composition.createIdentity(f.context);
 try {
  assert.ok(identity.ordinaryWorkspaces);
  assert.equal(identity.codexWorkspaceRouting,undefined);
  let local=0;
  const localFiles=async()=>{local++;return {files:{async request(){return {}}},assertCurrent(){}}};
  await composition.selectHostFiles('local-codex',{sender:null},{path:'/tmp'},localFiles);
  assert.equal(local,1);
  await assert.rejects(async()=>composition.selectHostFiles('local-codex',{sender:null},
   {path:'/workspace',workspaceThreadId:'foreign'},localFiles));
  assert.equal(local,1);
  const owner=identity.ordinaryWorkspaces;
  await identity.close();
  await assert.rejects(async()=>composition.selectHostFiles('local-codex',{sender:null},{path:'/tmp'},localFiles),/closed/);
  assert.equal(local,1);
  // Same persisted machine identity can reopen the real journal after drain.
  const successor=await joinIdentityComposition().createIdentity(f.context);
  try {assert.ok(successor.ordinaryWorkspaces);assert.notStrictEqual(successor.ordinaryWorkspaces,owner);}
  finally {await successor.close()}
 } finally {await identity.close()}
});


test('installed identity owns private workspace authority, routes and removes its socket on close',async t=>{
 const f=await fixture(t),socketPath=join(f.directory,'workspace.sock'),token='private-identity-fixture-'.repeat(3);
 const context={...f.context,workspaceExecution:{socketPath,token}};
 const identity=await joinIdentityComposition().createIdentity(context);
 let transport:DuplexTransport|undefined,frame:any;
 try{
  assert.equal((await lstat(socketPath)).mode&0o777,0o600);
  const hooks=identity.codexWorkspaceRouting.createCodexWorkspaceHooks({hostId:'local-codex'});
  const native:DuplexTransport={status:{state:'open'},async connect(){},async close(){},
   subscribeMessage(){return()=>{}},subscribeStatus(){return()=>{}},async send(value){frame=JSON.parse(value)}};
  transport=hooks.decorateNativeTransport(native,()=>({method:'thread/start',context:()=>({sender:null})}));
  await transport.send(JSON.stringify({id:'local-start',method:'thread/start',params:{}}));
  const {[workspaceGrantField]:ticket,...params}=frame.params;
  assert.deepEqual(await consumeWorkspaceExecutionGrant({socketPath,token},ticket,'thread/start',params),{kind:'local'});
  await assert.rejects(consumeWorkspaceExecutionGrant({socketPath,token},ticket,'thread/start',params));
  await transport.close();await identity.close();
  await assert.rejects(lstat(socketPath),{code:'ENOENT'});
  assert.throws(()=>identity.codexWorkspaceRouting.createCodexWorkspaceHooks({hostId:'local-codex'}),/closed/);
  const successor=await joinIdentityComposition().createIdentity(context);
  try{
   assert.ok(successor.codexWorkspaceRouting);
   await assert.rejects(consumeWorkspaceExecutionGrant({socketPath,token},ticket,'thread/start',params));
  }finally{await successor.close()}
 }finally{await transport?.close();await identity.close()}
});

test('unsafe authority directory rejects startup and releases the workspace journal',async t=>{
 const f=await fixture(t),unsafe=join(f.directory,'unsafe');await mkdir(unsafe,{mode:0o755});
 await assert.rejects(joinIdentityComposition().createIdentity({...f.context,
  workspaceExecution:{socketPath:join(unsafe,'workspace.sock'),token:'private-fixture-token-'.repeat(3)}}),/authority unavailable/);
 const successor=await joinIdentityComposition().createIdentity(f.context);
 try{assert.ok(successor.ordinaryWorkspaces);assert.equal(successor.codexWorkspaceRouting,undefined)}
 finally{await successor.close()}
});
