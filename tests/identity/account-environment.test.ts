import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AccountEnvironment, EnvironmentError } from '../../scripts/account-environment';
import { AccountEnvironmentHttp } from '../../scripts/account-environment-http';
import { EmployeeGitVaultStore } from '../../scripts/employee-git-vault-store';
import { parseEnvironmentDocument } from '../../packages/workbench-runtime/src/account-environment';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'account-env-')), vault = new EmployeeGitVaultStore(root);
  t.after(async () => { vault.close(); await rm(root, { recursive: true, force: true }); });
  return { root, vault, env: new AccountEnvironment(vault) };
}
const global = { projectId: null }, a = { projectId: 'project-a' }, b = { projectId: 'project-b' };
const entry = (value: string, secret = true, name = 'SERVICE_KEY') => ({ name, value, secret });

test('two employees and two projects remain separate; project deletion restores the personal default', async t => {
  const { env } = await fixture(t);
  env.replace('alice', global, 0, [entry('alice-global')]);
  env.replace('alice', a, 0, [entry('alice-a')]); env.replace('alice', b, 0, [entry('alice-b')]);
  env.replace('bob', global, 0, [entry('bob-global')]); env.replace('bob', a, 0, [entry('bob-a')]);
  assert.equal(env.launchEnvironment('alice', a, {}).SERVICE_KEY, 'alice-a');
  assert.equal(env.launchEnvironment('alice', b, {}).SERVICE_KEY, 'alice-b');
  assert.equal(env.launchEnvironment('bob', a, {}).SERVICE_KEY, 'bob-a');
  assert.equal(env.launchEnvironment('bob', b, {}).SERVICE_KEY, 'bob-global');
  assert.deepEqual(env.list('charlie', a).variables, []);
  env.replace('alice', a, 1, []);
  assert.equal(env.launchEnvironment('alice', a, {}).SERVICE_KEY, 'alice-global');
  assert.throws(() => env.replace('alice', a, 1, [entry('stale')]), { message: 'conflict' });
  assert.equal(env.list('alice', a).revision, 2);
});

test('all values are encrypted on disk; saved secrets never appear in read or mutation views', async t => {
  const { root, vault, env } = await fixture(t);
  const secret = 'synthetic-' + randomUUID(), normal = 'synthetic-normal-marker-3c93';
  const result = env.replace('alice', a, 0, [entry(secret), entry(normal, false, 'SERVICE_REGION')]);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.variables[0]!.value, null); assert.equal(result.variables[1]!.value, normal);
  for (const file of await readdir(root)) {
    const bytes = await readFile(join(root, file));
    assert.equal(bytes.includes(Buffer.from(secret)), false); assert.equal(bytes.includes(Buffer.from(normal)), false);
  }
  // Another owner uses the same managed DB/key without introducing a new schema.
  const peer = new EmployeeGitVaultStore(root); t.after(() => peer.close());
  assert.equal(new AccountEnvironment(peer).launchEnvironment('alice', a, {}).SERVICE_KEY, secret);
  vault.writeSecret('alice', 'synthetic-mcp', 0, 'synthetic-token');
  assert.equal(vault.readSecret('alice', 'synthetic-mcp').secret, 'synthetic-token');
  assert.equal(env.launchEnvironment('alice', a, {}).SERVICE_KEY, secret);
});

test('retaining a secret requires the same name and secret flag; empty replacements are valid', async t => {
  const { env } = await fixture(t);
  env.replace('alice', a, 0, [entry('original')]);
  env.replace('alice', a, 1, [{ name: 'SERVICE_KEY', secret: true, value: null }]);
  assert.equal(env.launchEnvironment('alice', a, {}).SERVICE_KEY, 'original');
  assert.throws(() => env.replace('alice', a, 2, [{ name: 'SERVICE_KEY', secret: false, value: null }]), EnvironmentError);
  assert.throws(() => env.replace('alice', b, 0, [{ name: 'SERVICE_KEY', secret: true, value: null }]), EnvironmentError);
  assert.throws(() => env.replace('bob', a, 0, [{ name: 'SERVICE_KEY', secret: true, value: null }]), EnvironmentError);
  assert.throws(() => env.replace('alice', a, 2, [{ name: 'OTHER_KEY', secret: true, value: null }]), EnvironmentError);
  env.replace('alice', a, 2, [entry('')]); assert.equal(env.launchEnvironment('alice', a, {}).SERVICE_KEY, '');
  env.replace('alice', a, 3, [entry('replacement', false)]); assert.equal(env.list('alice', a).variables[0]!.value, 'replacement');
});

test('reserved names are rejected without echoing the supplied value; launch preserves platform names', async t => {
  const { env } = await fixture(t);
  for (const name of ['HOME', 'path', 'https_proxy', 'BASH_ENV', 'NODE_OPTIONS', 'LD_PRELOAD', 'SSH_AUTH_SOCK',
    'OPENCRAFT_TOKEN', 'CODEX_HOME', 'DSH_HOME', 'PI_CODING_AGENT_DIR', 'ACP_TOKEN', 'GIT_CONFIG_COUNT', 'OPENAI_API_KEY']) {
    assert.throws(() => env.replace('alice', a, 0, [entry('never-in-an-error', true, name)]), { message: 'reserved' });
  }
  for (const name of ['', 'BAD-NAME', '1BAD', 'BAD\nNAME']) assert.throws(() => env.replace('alice', a, 0, [entry('hidden', true, name)]), { message: 'invalid' });
  assert.throws(() => env.replace('alice', a, 0, [entry('a'), entry('b')]), { message: 'invalid' });
  env.replace('alice', a, 0, [entry('personal', true, 'FUTURE_PLATFORM_KEY')]);
  const base = { FUTURE_PLATFORM_KEY: 'platform', HOME: '/synthetic' };
  assert.throws(() => env.launchEnvironment('alice', a, base), { message: 'reserved' });
  assert.deepEqual(base, { FUTURE_PLATFORM_KEY: 'platform', HOME: '/synthetic' });
});

test('real child processes receive per-launch snapshots; old processes retain their environment', async t => {
  const { env } = await fixture(t);
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  const program = `const c=require('node:crypto');process.stdin.once('data',()=>{process.stdout.write(c.createHash('sha256').update(process.env.SERVICE_KEY??'missing').digest('hex'));});`;
  env.replace('alice', a, 0, [entry('generation-one')]);
  const base = { ...process.env }; delete base.SERVICE_KEY;
  const launch = () => spawn(process.execPath, ['-e', program], { env: env.launchEnvironment('alice', a, base), stdio: ['pipe', 'pipe', 'pipe'] });
  const old = launch(); t.after(() => old.kill());
  env.replace('alice', a, 1, [entry('generation-two')]);
  const next = launch(); t.after(() => next.kill());
  const read = async (child: ReturnType<typeof launch>) => {
    const result: Buffer[] = []; child.stdout.on('data', chunk => result.push(chunk)); child.stdin.end('go');
    const [code] = await once(child, 'close'); assert.equal(code, 0); return Buffer.concat(result).toString();
  };
  assert.deepEqual(await Promise.all([read(old), read(next)]), [digest('generation-one'), digest('generation-two')]);
  assert.equal(process.env.SERVICE_KEY, base.SERVICE_KEY);
});

test('HTTP binds identity and admission, masks responses, rejects account selection and cross-origin writes', async t => {
  const { env } = await fixture(t), api = new AccountEnvironmentHttp(env);
  let admitted = true, current = true;
  const server = createServer((request, response) => {
    const account = request.headers['x-synthetic-user'] === 'bob' ? 'bob' : 'alice';
    void api.handle(request, response, { account, current: () => current && admitted,
      projects: async () => [{ id: 'project-a', name: 'Project A' }, { id: 'project-b', name: 'Project B' }] });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as any).port}/environment`;
  const request = (body?: unknown, headers: Record<string, string> = {}) => fetch(url, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-opencraft-account-scope': 'alice', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const save = { projectId: 'project-a', revision: 0, variables: [entry('synthetic-http-secret')] };
  let response = await request(save); assert.equal(response.status, 200);
  let payload = await response.json(); assert.equal(JSON.stringify(payload).includes('synthetic-http-secret'), false);
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(payload.variables[0].value, null);
  assert.deepEqual(parseEnvironmentDocument(payload).projects.map(p => p.id), ['project-a', 'project-b']);
  assert.equal((await request({ ...save, revision: 1, account: 'bob' })).status, 400);
  assert.equal((await request({ ...save, projectId: 'unknown' })).status, 400);
  assert.equal((await request(save, { origin: 'https://other.example.test' })).status, 403);
  assert.equal((await request(save, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await request(save, { 'x-synthetic-user': 'bob' })).status, 401);
  response = await request(undefined, { 'x-synthetic-user': 'bob', 'x-opencraft-account-scope': 'bob' });
  payload = await response.json(); assert.deepEqual(payload.variables, []);
  admitted = false; assert.equal((await request()).status, 401);
  admitted = true; current = false; assert.equal((await request(save)).status, 401);
  assert.throws(() => parseEnvironmentDocument({ ...payload, variables: [{ name: 'KEY', secret: true, value: 'clear' }] }), { message: 'invalid' });
});

test('identity changes while awaiting project lookup cannot read or modify a previous account', async t => {
  const { env } = await fixture(t), api = new AccountEnvironmentHttp(env);
  let current = true;
  const server = createServer((request, response) => {
    void api.handle(request, response, { account: 'alice', current: () => current,
      projects: async () => { current = false; return []; } });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as any).port}/environment`;
  const response = await fetch(url, { headers: { 'x-opencraft-account-scope': 'alice' } }); assert.equal(response.status, 401);
});
