import { zstdDecompressSync } from "node:zlib";
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexEngineAdapter } from '../../../apps/opencraft-daemon/src/codex-engine-adapter.js';
import { AccountPoolStore } from '@opencraft/account-pool-host';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
import { AccountEnvironment } from '../../account-environment.js';
import { ExecutionEnvironmentRuntime, environmentProjectId } from '../../execution-environment.js';
import { EmployeeGitVaultStore } from '../../employee-git-vault-store.js';

const root = await mkdtemp(join(tmpdir(), 'codex-environment-smoke-'));
const vault = new EmployeeGitVaultStore(root), environment = new AccountEnvironment(vault), runtime = new ExecutionEnvironmentRuntime(root, vault);
const projectId = 'project-placeholder';
const secret = 'synthetic-environment-' + crypto.randomUUID();
const expected = createHash('sha256').update(secret).digest('hex');

const pool = new AccountPoolStore({ databasePath: join(root, 'codex/account-pool.sqlite'), secretsDirectory: join(root, 'codex/secrets') });
pool.addAccount({ id: 'fixture', provider: 'codex', label: 'Fixture', upstreamAccountId: 'fixture', priority: 1, enabled: true }, { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: null }); pool.close();
let requests = 0, observed = false;
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (request.url?.includes('/models')) { response.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-test', object: 'model', owned_by: 'fixture' }] })); return; }
  const bytes = Buffer.concat(chunks);
  const body = (request.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(bytes) : bytes).toString(); const tools = JSON.parse(body).tools ?? []; assert.equal(body.includes(secret), false);
  observed ||= body.includes(expected);
  const tool = ++requests % 2 === 1;
  const selected = tools.find((tool: any) => ['exec_command', 'shell_command', 'shell'].includes(tool.name));
  const command = `${JSON.stringify(process.execPath)} -e \"process.stdout.write(require('node:crypto').createHash('sha256').update(process.env.SERVICE_KEY??'missing').digest('hex'))\"`;
  const item = tool ? { id: 'fc-' + requests, type: 'function_call', call_id: 'call-' + requests, name: selected?.name ?? 'exec_command', arguments: JSON.stringify(selected?.name === 'shell_command' ? { command } : selected?.name === 'shell' ? { command: [process.execPath, '-e', "process.stdout.write(require('node:crypto').createHash('sha256').update(process.env.SERVICE_KEY??'missing').digest('hex'))"] } : { cmd: command, yield_time_ms: 1000, max_output_tokens: 1000 }) }
    : { id: 'msg-' + requests, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'probe complete', annotations: [] }] };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of [
    { type: 'response.created', response: { id: 'r-' + requests, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'r-' + requests, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
const diagnostics: unknown[] = [], frames: any[] = [];
const adapter = new CodexEngineAdapter({ executable: process.env.OPENCRAFT_CODEX_EXECUTABLE ?? 'codex', runtimeDirectory: root, dataDirectory: join(root, 'codex'), nativeCodexHomeDirectory: join(root, 'native'), executionEnvironment: runtime,
  upstreamBaseUrl: `http://127.0.0.1:${(model.address() as any).port}/backend-api/codex`, fetch: async (input, init) => String(input).includes('/wham/usage') ? Response.json({ plan_type: 'fixture' }) : fetch(input, init), logDiagnostic: event => diagnostics.push(event) });
adapter.subscribeMessage(frame => frames.push(JSON.parse(frame)));
const wait = async (predicate: (frame: any) => boolean) => { const deadline = Date.now() + 120_000; while (Date.now() < deadline) { const found = frames.find(predicate); if (found) return found; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('Codex environment smoke timed out'); };
let sequence = 0;
const call = async (method: string, params: object, authenticated = false) => {
  const id = ++sequence, frame = JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: 'smoke' });
  if (authenticated) await adapter.sendWithContext(frame, { sender: { kind: 'employee', loginName: 'alice' }, executionPrincipal: { provider: 'employee', subject: 'alice' }, validUntil: Date.now() + 120_000 }); else await adapter.send(frame);
  const result = await wait(frame => frame.id === id); if (result.error) throw new Error('Native request failed: ' + method + ':' + result.error.message); return result.result;
};
try {
  await adapter.connect(); await call('initialize', { clientInfo: { name: 'environment-smoke', version: '1' }, capabilities: { experimentalApi: true } });
  const project = (await call('project/create', { name: 'Environment smoke', roots: [{ path: root }], idempotencyKey: crypto.randomUUID() })).project;
  environment.replace('employee:alice', { projectId: environmentProjectId('local-codex', project.id) }, 0, [{ name: 'SERVICE_KEY', value: secret, secret: true }]);
  const created = await call('thread/start', { projectId: project.id, cwd: root, model: 'gpt-test', approvalPolicy: 'never', sandbox: 'danger-full-access' }, true);
  const threadId = created.thread.id; runtime.bind('local-codex', threadId, project.id);
  await call('turn/start', { threadId, input: [{ type: 'text', text: 'probe environment', text_elements: [] }], clientUserMessageId: 'environment-input' }, true);
  await wait(frame => frame.method === 'turn/completed' && frame.params.threadId === threadId);
  assert.equal(observed, true, 'Native exec_command must read the employee/project value');
  assert.equal(JSON.stringify([frames, diagnostics]).includes(secret), false);
  await adapter.close();
  const files = async (path: string): Promise<string[]> => (await Promise.all((await readdir(path, { withFileTypes: true })).map(async entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]))).flat();
  for (const file of await files(root)) assert.equal((await readFile(file)).includes(Buffer.from(secret)), false, 'Private environment must not persist in native configuration, rollouts or logs');
  console.log(JSON.stringify({ status: 'passed', engine: 'codex', nativeShell: true, encryptedPersistence: true, diagnosticsRedacted: true, requests }));
} finally { await adapter.close(); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); vault.close(); await rm(root, { recursive: true, force: true }); }
