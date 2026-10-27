import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, readlink, stat, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import ssh2 from 'ssh2';
import { generateKeyPairSync } from 'node:crypto';
import { createProtocolIngress } from "../../web-deployment/protocol-ingress.mjs";
import { chromium } from '@playwright/test';
import { startCodexCore } from '../../../apps/codex-core/src/main.ts';
import { AccountPoolStore } from '../../../packages/account-pool-host/src/index.ts';
import { createManagedWebServer } from '../../web-deployment/server.mjs';
import { createExecutionDeployment, coreHealth } from '../../server-deployment/execution.mjs';
import { seedLegacyHostStorage } from '../../../tests/support/local-agent-storage-fixture.js';
import { releaseFixture } from '../../../tests/support/web-deployment-fixture.mjs';

let runAbort: AbortController | undefined;
async function until(read: () => any, label: string, timeout = 40_000, abortable = true): Promise<any> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (abortable) runAbort?.signal.throwIfAborted(); const value = await read(); if (value) return value; await delay(50); }
  throw new Error(`Timeout: ${label}`);
}
if (process.argv[2] === 'core') {
  const cfg = JSON.parse(await readFile(process.argv[3], 'utf8'));
  const core = await startCodexCore({ endpoint: cfg.endpoint, authToken: cfg.token, executable: 'codex',
    runtimeDirectory: cfg.root, dataDirectory: cfg.data, nativeCodexHomeDirectory: join(cfg.root, 'native'), upstreamBaseUrl: cfg.upstream,
    fetch: async (input: any, init: any) => {
      const url = new URL(String(input));
      if (url.hostname === '127.0.0.1') return fetch(input, init);
      if (url.pathname.endsWith('/wham/usage')) return Response.json({ plan_type: 'fixture', rate_limit: { primary_window: { used_percent: 1 } } });
      throw new Error('External network is disabled in this smoke test');
    } });
  process.once('SIGTERM', () => void core.close().then(() => process.exit(0)));
  console.log('core-ready');
} else {
  runAbort = new AbortController();
  const interrupt = () => runAbort!.abort(new Error('Server update smoke interrupted'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const root = await mkdtemp(join(tmpdir(), 'oc-server-update-'));
  const data = join(root, 'execution-state/codex'), state = join(root, 'execution-state');
  await mkdir(join(data, 'runtime'), { recursive: true }); await mkdir(state, { recursive: true }); await chmod(state, 0o700); await mkdir(join(root, 'home')); await mkdir(join(root, 'native'));
  await writeFile(join(data, 'runtime/config.toml'), '[features]\nplugins = false\n');
  seedLegacyHostStorage(join(state, 'agent'));
  const token = 'synthetic-' + 'x'.repeat(48); const tokenPath = join(state, 'daemon.token'); await writeFile(tokenPath, token, { mode: 0o600 });
  const store = new AccountPoolStore({ databasePath: join(data, 'account-pool.sqlite'), secretsDirectory: join(data, 'secrets') });
  store.addAccount({ id: 'fixture', provider: 'codex', label: 'fixture', upstreamAccountId: 'fixture', priority: 1, enabled: true }, { accessToken: 'synthetic-only', refreshToken: null, expiresAt: null }); store.close();
  const calls: any[] = []; let serial = 0;
  const selfUpgrade = process.env.OPENCRAFT_SERVER_SMOKE_SELF_UPGRADE === '1';
  let toolCommand = 'echo started >> shell-count; sleep 30; echo finished >> shell-count; echo UPDATE_TASK_FINISHED';
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    // Title generation is an independent structured-output request, never a
    // shell turn. Honor its schema rather than guessing from prompt/tool text.
    const title = input.text?.format?.schema?.properties?.title?.type === 'string';
    const tool = !title && !JSON.stringify(input.input).includes('function_call_output');
    calls.push({ tool, title, path: req.url, model: input.model, previousResponse: Boolean(input.previous_response_id),
      inputTypes: Array.isArray(input.input) ? input.input.map((item: any) => item.type ?? item.role ?? 'unknown') : typeof input.input });
    res.writeHead(200, { 'content-type': 'text/event-stream' }); const id = `fixture-${++serial}`;
    const send = (event: any) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({ type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } });
    const item = tool ? { id, type: 'function_call', call_id: id, name: 'exec_command', status: 'completed', arguments: JSON.stringify({ cmd: toolCommand, yield_time_ms: 30000, max_output_tokens: 100 }) }
      : { id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: title ? JSON.stringify({ title: 'Update acceptance fixture' }) : 'UPDATE_TASK_FINISHED', annotations: [] }] };
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } });
    send({ type: 'response.output_item.done', output_index: 0, item });
    send({ type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end();
  });
  await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done));
  const endpoint = join(root, 'core/control.sock');
  const cfg = { root, data, endpoint, token, upstream: `http://127.0.0.1:${(upstream.address() as any).port}` };
  await writeFile(join(root, 'config.json'), JSON.stringify(cfg), { mode: 0o600 });
  const env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: join(root, 'home'), HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost' };
  const systemd = process.env.OPENCRAFT_SERVER_SMOKE_SYSTEMD === '1';
  if (!systemd) throw new Error('Headless acceptance requires real isolated systemd units');
  const prefix = `opencraft-update-smoke-${root.split('/').pop()}`;
  const coreUnit = `${prefix}-core.service`, executionUnit = `${prefix}-execution.service`;
  const unitPaths: string[] = [];
  function control(...args: string[]) { return execFileSync('systemctl', args, { encoding: 'utf8' }); }
  async function createUnit(name: string, command: string, extra: Record<string, string> = {}) {
    const environmentPath = join(root, `${name}.env`);
    await writeFile(environmentPath, Object.entries({ ...env, ...extra }).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n'), { mode: 0o600 });
    const path = `/run/systemd/system/${name}`;
    await writeFile(path, `[Unit]\nDescription=Isolated OpenCraft update acceptance\n[Service]\nType=simple\nWorkingDirectory=${root}\nEnvironmentFile=${environmentPath}\nExecStart=${command}\nKillMode=control-group\nTimeoutStopSec=150\n`);
    unitPaths.push(path);
  }
  let ingress: any; const sshClients: any[] = [];
  let fixture: any, app: any, browser: any; const sockets: WebSocket[] = [];
  const logs: string[] = []; let gatewayPort: number;
  async function tree(pid: number): Promise<number[]> {
    try {
      const tasks = await readdir(`/proc/${pid}/task`);
      const children = [...new Set((await Promise.all(tasks.map(t => readFile(`/proc/${pid}/task/${t}/children`, 'utf8').catch(() => '')))).join(' ').split(/\s+/).filter(Boolean).map(Number))];
      return [pid, ...(await Promise.all(children.map(tree))).flat()];
    } catch { return []; }
  }
  async function connect(url: string) {
    const origin = url.replace('ws:', 'http:').replace(/\/apphost$/, '');
    const socket = new WebSocket(url, { origin }); sockets.push(socket);
    const frames: any[] = []; const hostFrames: any[] = []; let sequence = 0; let generation: number;
    const leaseId = 'headless-smoke';
    socket.on('message', b => {
      const message = JSON.parse(b.toString()); hostFrames.push(message);
      if (message.type === 'host/frame') frames.push(JSON.parse(message.frame));
    });
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: 2, rendererId: 'headless-smoke' }));
    await until(() => hostFrames.some(frame => frame.type === 'ready'), 'Headless ready');
    socket.send(JSON.stringify({ type: 'host/connect', requestId: 'connect', hostId: 'local-codex', leaseId }));
    const connected = await until(() => hostFrames.find(frame => frame.requestId === 'connect'), 'Headless connect');
    assert.equal(connected.ok, true); generation = connected.result.generation;
    const rpc = async (method: string, params: any = {}) => {
      const id = ++sequence;
      socket.send(JSON.stringify({ type: 'host/send', requestId: 'send-' + id, hostId: 'local-codex', leaseId, generation, frame: JSON.stringify({ id, method, params }) }));
      const reply = await until(() => frames.find(f => f.id === id && !f.method), method);
      if (reply.error) throw new Error(JSON.stringify(reply.error)); return reply.result;
    };
    const initialized = await rpc('initialize', { clientInfo: { name: 'headless-update-smoke', version: '1' }, capabilities: { experimentalApi: true } });
    assert.equal(initialized.capabilities.extensions['opencraft/bot-conversations'], undefined);
    const respond = (id: string | number, result: unknown) => socket.send(JSON.stringify({ type: 'host/send', requestId: 'reply-' + (++sequence), hostId: 'local-codex', leaseId, generation, frame: JSON.stringify({ id, result }) }));
    return { socket, rpc, frames, respond };
  }
  async function connectSsh(base: string, userKey: string, hostKey: string) {
    const url = new URL(base); const client = new ssh2.Client(); sshClients.push(client);
    const ready = once(client, 'ready'); client.on('error', () => {});
    client.connect({ host: '127.0.0.1', port: Number(url.port), username: 'fixture', privateKey: userKey,
      hostVerifier: (value: Buffer) => value.equals(ssh2.utils.parseKey(hostKey).getPublicSSH()), readyTimeout: 5000 });
    await ready;
    const stream: any = await new Promise((accept, reject) => client.exec('codex app-server proxy', (error: any, stream: any) => error ? reject(error) : accept(stream)));
    const socket = new WebSocket('ws://127.0.0.1/rpc', { createConnection: () => stream }); sockets.push(socket);
    const frames: any[] = []; let seq = 0;
    socket.on('message', raw => frames.push(JSON.parse(String(raw)))); await once(socket, 'open');
    const rpc = async (method: string, params: any = {}) => { const id = ++seq; socket.send(JSON.stringify({ id, method, params }));
      const reply = await until(() => frames.find(value => value.id === id && !value.method), 'SSH ' + method);
      if (reply.error) throw new Error(JSON.stringify(reply.error)); return reply.result; };
    await rpc('initialize', { clientInfo: { name: 'headless-ssh-smoke', version: '1' }, capabilities: { experimentalApi: true } });
    return { socket, rpc };
  }
  try {
    const coreArgs = ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('scripts/smoke/server/smoke-headless-server-updates.ts'), 'core', join(root, 'config.json')];
    await createUnit(coreUnit, [process.execPath, ...coreArgs].join(' ')); control('daemon-reload'); control('start', coreUnit);
    await until(async () => coreHealth(endpoint, tokenPath).catch(() => null), 'systemd core readiness');
    // Reserve then release a private port; this test never addresses a user deployment.
    const reserve = createServer(); await new Promise<void>(done => reserve.listen(0, '127.0.0.1', done));
    gatewayPort = (reserve.address() as any).port; await new Promise<void>(done => reserve.close(done));
    fixture = await releaseFixture(root, { execution: true, executionProfile: 'headless', realWebRoot: resolve('apps/workbench-web/dist') });
    const link = join(root, 'execution-current');
    const gatewayEnv = { OPENCRAFT_EXECUTION_CWD: root, OPENCRAFT_EXECUTION_STATE: state,
      OPENCRAFT_CODEX_CORE_ENDPOINT: endpoint, OPENCRAFT_GATEWAY_PORT: String(gatewayPort), OPENCRAFT_DSH_EXECUTABLE: resolve('runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js') };
    const key = () => generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
    const hostKey = key(), userKey = key();
    const ingressConfig = join(root, 'ingress.json');
    await writeFile(join(root, 'host-key'), hostKey, { mode: 0o600 });
    await writeFile(ingressConfig, JSON.stringify({ hostKeyFile: 'host-key', authorizedKeys: { fixture: ['ssh-rsa ' + ssh2.utils.parseKey(userKey).getPublicSSH().toString('base64')] } }), { mode: 0o600 });
    const headlessConfig = join(root, 'headless.json');
    await writeFile(headlessConfig, JSON.stringify({ argv: ['--host', '0.0.0.0', '--allow-unauthenticated-public', '--ssh-public-access', '--port', String(gatewayPort), '--data-dir', state, '--ssh-config', ingressConfig] }), { mode: 0o600 });
    Object.assign(gatewayEnv, { OPENCRAFT_HEADLESS_CONFIG: headlessConfig, OPENCRAFT_DAEMON_TOKEN_FILE: tokenPath, OPENCRAFT_RUNTIME_DIRECTORY: resolve('runtime'), OPENCRAFT_CODEX_EXECUTABLE: execFileSync('which', ['codex'], { encoding: 'utf8' }).trim() });
    if (systemd) { await createUnit(executionUnit, `${process.execPath} ${link}/execution/gateway.mjs`, gatewayEnv); control('daemon-reload'); }
    const gatewayPid = () => Number(control('show', executionUnit, '--property=MainPID', '--value').trim());
    const execution = createExecutionDeployment({ link, unit: executionUnit, coreUnit, coreEndpoint: endpoint, tokenPath, profile: 'headless',
      healthUrl: `http://127.0.0.1:${gatewayPort}/health`,
    });
    app = await createManagedWebServer({ initialRelease: fixture.releases.get('1.0.0').packageRoot, stateDirectory: join(root, 'web-state'), source: fixture.source, execution,
      headlessBackendTarget: `http://127.0.0.1:${gatewayPort}` });
    const privateWeb = await app.listen({ port: 0 });
    ingress = createProtocolIngress({ httpPort: privateWeb.port, sshTarget: `http://127.0.0.1:${gatewayPort}` });
    const publicAddress = await ingress.listen({ port: 0 });
    const base = `http://127.0.0.1:${publicAddress.port}`;
    const sshBefore = await connectSsh(base, userKey, hostKey);
    if (selfUpgrade) {
      const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
      toolCommand = `echo started >> shell-count && OPENCRAFT_WEB_STATE=${quote(join(root, 'web-state'))} OPENCRAFT_WEB_UPDATE_URL=${quote(base)} OPENCRAFT_WEB_PACKAGE_OUTPUT=${quote(join(root, 'self-built'))} ${quote(process.execPath)} ${quote(resolve('scripts/update-server-local.mjs'))} --version 1.1.0 && echo finished >> shell-count && echo UPDATE_TASK_FINISHED`;
    }
    const initialHealth = await (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).json();
    assert.equal(initialHealth.ok, true);
    assert.deepEqual(Object.fromEntries(initialHealth.storage.map((item: any) => [item.name, item.status])), {
      'session-routing': 'migrated', threads: 'adopted', executions: 'fresh',
      'host-documents': 'fresh', 'managed-connectors': 'adopted', tasks: 'fresh', 'opencraft-host-state': 'fresh', 'conversation-schedules': 'fresh',
      'opencraft-message-attachments': 'fresh', 'actor-collaboration': 'fresh', actors: 'fresh', 'ssh-connections': 'fresh',
    });
    const backupFiles = (await readdir(join(state, 'agent'))).filter(name => name.includes('.pre-v1-'));
    const movedAsideFiles = (await readdir(join(state, 'agent'))).filter(name => name.includes('.legacy-'));
    assert.equal(backupFiles.length, 3); assert.deepEqual(movedAsideFiles, []);
    const legacyThreads = new DatabaseSync(join(state, 'agent/opencraft-threads.sqlite'), { readOnly: true });
    try {
      const row = legacyThreads.prepare('SELECT document FROM opencraft_threads WHERE id = ?').get('legacy-thread');
      assert.equal(JSON.parse(String(row?.document)).manualTitle, 'Legacy title');
    } finally { legacyThreads.close(); }
    for (const item of initialHealth.storage) if (item.backupPath) assert.ok((await stat(item.backupPath)).size > 0);
    const before = await coreHealth(endpoint, tokenPath);
    const A = await connect(base.replace('http:', 'ws:') + '/apphost');
    const threadId = (await A.rpc('thread/start', { cwd: root, model: 'gpt-6-luna', approvalPolicy: 'never', sandbox: 'danger-full-access' })).thread.id;
    const turnId = (await A.rpc('turn/start', { threadId, input: [{ type: 'text', text: 'TOOL', text_elements: [] }] })).turn.id;
    await until(async () => (await readFile(join(root, 'shell-count'), 'utf8').catch(() => '')).includes('started'), 'running shell');
    const runningTree = await tree(before.pid); const oldGatewayPid = gatewayPid();
    browser = await chromium.launch({ headless: true, ...(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE } : {}) });
    const page = await browser.newPage(); await page.goto(base + '/settings/updates');
    if (!selfUpgrade) {
      await page.getByLabel(/^(Deployment administrator key|部署管理员密钥)$/).fill((await readFile(app.adminKeyPath, 'utf8')).trim());
      await page.getByRole('button', { name: /^(Authorize management|授权管理)$/ }).click();
      await page.getByRole('button', { name: /^(Check updates|检查更新)$/ }).click();
      const install = page.getByRole('button', { name: /^(Update website and execution service|更新网站和执行服务)$/ });
      await until(() => install.isEnabled(), 'browser discovers server update'); await install.click();
    }
    await until(async () => { const s = await (await fetch(base + '/__opencraft_updates')).json(); if (s.job?.phase === 'failed') throw new Error(s.job.error); return s.job?.phase === 'completed'; }, 'update completion', 120_000);
    assert.notEqual(gatewayPid(), oldGatewayPid);
    const upgradedHealth = await (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).json();
    assert.equal(upgradedHealth.ok, true); assert.ok(upgradedHealth.storage.every((item: any) => item.status === 'up-to-date'));
    const after = await coreHealth(endpoint, tokenPath); assert.deepEqual(after, before);
    const afterTree = await tree(before.pid);
    for (const pid of selfUpgrade ? runningTree.slice(0, 3) : runningTree) assert.ok(afterTree.includes(pid), `Running process ${pid} survived upgrade`);
    await until(() => sshBefore.socket.readyState === WebSocket.CLOSED, 'old SSH channel retired after execution update');
    const sshAfter = await connectSsh(base, userKey, hostKey);
    assert.equal((await sshAfter.rpc('thread/read', { threadId, includeTurns: true })).thread.id, threadId);
    const B = await connect(base.replace('http:', 'ws:') + '/apphost');
    await B.rpc('thread/resume', { threadId });
    const history = await until(async () => { const h = await B.rpc('thread/read', { threadId, includeTurns: true }); return h.thread.turns.some((t: any) => t.id === turnId && t.status === 'completed') ? h : null; }, 'original turn completion', 90_000); assert.match(JSON.stringify(history), /UPDATE_TASK_FINISHED/);
    await until(async () => (await readFile(join(root, 'shell-count'), 'utf8')).includes('finished'), 'shell finished');
    assert.equal(await readFile(join(root, 'shell-count'), 'utf8'), 'started\nfinished\n'); assert.equal(calls.filter(c => c.tool).length, 1, JSON.stringify(calls));
    const originalToolCalls = calls.filter(call => call.tool).length;
    toolCommand = 'echo APPROVAL_EXECUTED >> approval-result';
    const approvalOwner = await connect(base.replace('http:', 'ws:') + '/apphost');
    const approvalThread = await approvalOwner.rpc('thread/start', { cwd: root, model: 'gpt-6-luna', approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
    const approvalTurn = await approvalOwner.rpc('turn/start', { threadId: approvalThread.thread.id, input: [{ type: 'text', text: 'approval-only synthetic tool' }] });
    const approval = await until(() => approvalOwner.frames.find(frame => frame.id !== undefined && frame.method === 'item/commandExecution/requestApproval'), 'original pending approval', 10000);
    control('restart', executionUnit);
    await until(async () => (await fetch(`http://127.0.0.1:${gatewayPort}/health`).then(r => r.json()).catch(() => null))?.ok, 'approval restart ready');
    assert.deepEqual(await coreHealth(endpoint, tokenPath), before);
    const restoredApprovalOwner = await connect(base.replace('http:', 'ws:') + '/apphost');
    await restoredApprovalOwner.rpc('thread/resume', { threadId: approvalThread.thread.id });
    const restoredApproval = await until(() => restoredApprovalOwner.frames.find(frame => frame.id !== undefined && frame.method === approval.method), 'restored pending approval', 10000);
    restoredApprovalOwner.respond(restoredApproval.id, { decision: 'accept' });
    await until(async () => { const value = await restoredApprovalOwner.rpc('thread/read', { threadId: approvalThread.thread.id, includeTurns: true }); return value.thread.turns.some((turn: any) => turn.id === approvalTurn.turn.id && turn.status === 'completed'); }, 'approved original turn completes', 30000);
    assert.equal(await readFile(join(root, 'approval-result'), 'utf8'), 'APPROVAL_EXECUTED\n');
    if (selfUpgrade) {
      await page.reload();
      await page.getByLabel(/^(Deployment administrator key|部署管理员密钥)$/).fill((await readFile(app.adminKeyPath, 'utf8')).trim());
      await page.getByRole('button', { name: /^(Authorize management|授权管理)$/ }).click();
    }
    await page.getByRole('button', { name: /^(Roll back previous version|回退上一版)$/ }).click();
    await until(async () => { const s = await (await fetch(base + '/__opencraft_updates')).json(); return s.current.version === '1.0.0' && s.job.phase === 'completed'; }, 'browser rollback');
    assert.deepEqual(await coreHealth(endpoint, tokenPath), before);
    const sshRollback = await connectSsh(base, userKey, hostKey);
    assert.match(JSON.stringify(await sshRollback.rpc('thread/read', { threadId, includeTurns: true })), /UPDATE_TASK_FINISHED/);
    const C = await connect(base.replace('http:', 'ws:') + '/apphost');
    const restored = await C.rpc('thread/read', { threadId, includeTurns: true }); assert.match(JSON.stringify(restored), /UPDATE_TASK_FINISHED/);
    const rolledBackHealth = await (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).json();
    assert.equal(rolledBackHealth.ok, true); assert.ok(rolledBackHealth.storage.every((item: any) => item.status === 'up-to-date'));
    // Failure injection is confined to this isolated package and synthetic profile.
    fixture.select('1.4.0');
    assert.equal((await page.request.post(base + '/__opencraft_updates/check', { headers: { origin: base }, data: {} })).status(), 202);
    await until(async () => (await (await fetch(base + '/__opencraft_updates')).json()).latest?.version === '1.4.0', 'failed candidate check');
    assert.equal((await page.request.post(base + '/__opencraft_updates/install', { headers: { origin: base }, data: { version: '1.4.0' } })).status(), 202);
    const failed = await until(async () => { const value = await (await fetch(base + '/__opencraft_updates')).json(); return value.job?.phase === 'failed' ? value : null; }, 'Headless execution failure rollback', 120_000);
    assert.match(failed.job.error, /Execution release failed readiness/); assert.equal(failed.current.version, '1.0.0');
    assert.deepEqual(await coreHealth(endpoint, tokenPath), before);
    const recovered = await (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).json();
    assert.equal(recovered.ok, true); assert.equal(recovered.version, '1.0.0');
    const sshRecovered = await connectSsh(base, userKey, hostKey);
    assert.match(JSON.stringify(await sshRecovered.rpc('thread/read', { threadId, includeTurns: true })), /UPDATE_TASK_FINISHED/);
    const storageFailure = { error: failed.job.error, rolledBackVersion: recovered.version, storage: recovered.storage, isolatedExecutionStartupRejected: true };
    await ingress.close(); await app.close();
    app = await createManagedWebServer({ initialRelease: fixture.releases.get('1.0.0').packageRoot, stateDirectory: join(root, 'web-state'), source: fixture.source, execution,
      headlessBackendTarget: `http://127.0.0.1:${gatewayPort}` });
    const recoveredWeb = await app.listen({ port: 0 });
    ingress = createProtocolIngress({ httpPort: recoveredWeb.port, sshTarget: `http://127.0.0.1:${gatewayPort}` });
    await ingress.listen({ port: publicAddress.port });
    const afterBootstrap = await (await fetch(base + '/__opencraft_updates')).json();
    assert.equal(afterBootstrap.current.version, '1.0.0'); assert.equal(afterBootstrap.execution.ready, true);
    assert.equal(afterBootstrap.execution.profile, 'headless'); assert.equal(afterBootstrap.job.phase, 'failed');
    assert.deepEqual(await coreHealth(endpoint, tokenPath), before);
    for (const file of [...backupFiles, ...movedAsideFiles]) assert.ok((await stat(join(state, 'agent', file))).size > 0);
    const proof = { profile: 'headless', pendingApprovalRestoredAndCompleted: true, approvalToolCalls: calls.filter(call => call.tool).length - originalToolCalls, bootstrapRestartRecovered: true, executionFailureRolledBack: true, samePortHttpWsSsh: true, sshHostKeyPreserved: true, sshReconnectedAfterUpdateAndRollback: true, storageBefore: initialHealth.storage, storageAfterUpgrade: upgradedHealth.storage, storageAfterRollback: rolledBackHealth.storage,
      backupFiles, movedAsideFiles, storageFailure, model: 'gpt-6-luna', at: new Date().toISOString(), cli: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(), threadId, turnId,
      before, after, runningPids: runningTree, afterPids: afterTree, oldGatewayPid, newGatewayPid: gatewayPid(),
      toolCalls: originalToolCalls, shellExecutions: 1, browserInstall: !selfUpgrade, sourceSelfUpgrade: selfUpgrade, browserRollback: true,
      boundary: `Real npm CLI, Headless production SPA and payload, downstream overlays and real Codex CLI; synthetic loopback inference; both releases packaged from current source, no N-1 old-binary rollback claim; ${systemd ? 'real isolated systemd units and restart' : 'systemd restart replaced by isolated process restart'}` };
    const output = resolve(process.env.OPENCRAFT_SERVER_UPDATE_EVIDENCE_DIRECTORY || '.local/server-updates'); await mkdir(output, { recursive: true }); await writeFile(join(output, selfUpgrade ? 'self-upgrade-proof.json' : systemd ? 'systemd-proof.json' : 'proof.json'), JSON.stringify(proof, null, 2));
    console.log(JSON.stringify({ ok: true, shellExecutions: 1, originalTurnCompleted: true, corePidsUnchanged: true, browserInstall: !selfUpgrade, sourceSelfUpgrade: selfUpgrade, browserRollback: true, systemd }));
  } catch (error) {
    if (systemd) for (const name of [executionUnit, coreUnit]) { try { logs.push(execFileSync('journalctl', ['-u', name, '--no-pager', '-n', '80'], { encoding: 'utf8' })); } catch {} }
    console.error(logs.join('').slice(-12000)); throw error;
  } finally {
    const cleanupErrors: string[] = [];
    async function clean(label: string, operation: () => any) {
      try { await operation(); } catch (error) { cleanupErrors.push(`${label}: ${String(error)}`); }
    }
    await clean('browser', () => browser?.close());
    for (const socket of sockets) socket.terminate();
    for (const client of sshClients) client.destroy();
    await clean('protocol ingress', () => ingress?.close());
    await clean('website', () => app?.close());
    if (systemd) {
      for (const path of [...unitPaths].reverse()) {
        const name = path.split('/').pop()!;
        await clean(name, () => {
          const state = control('show', name, '--property=ActiveState', '--value').trim();
          if (state !== 'inactive') control('stop', name);
          if (control('show', name, '--property=ActiveState', '--value').trim() === 'failed') control('reset-failed', name);
        });
      }
      if (cleanupErrors.length === 0) {
        for (const path of unitPaths) await clean(path, () => rm(path, { force: true }));
        await clean('unit reload', () => control('daemon-reload'));
      }
    }
    await clean('registry', () => fixture?.close());
    upstream.closeAllConnections(); await clean('upstream', () => new Promise<void>(done => upstream.close(done)));
    if (cleanupErrors.length === 0) await clean('profile', () => rm(root, { recursive: true, force: true }));
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    if (cleanupErrors.length) throw new Error(`Server update cleanup failed; inspect ${root}: ${cleanupErrors.join('; ')}`);
  }
}
