import assert from 'node:assert/strict';
import { zstdDecompressSync } from 'node:zlib';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, readlink, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { chromium } from '@playwright/test';
import { startCodexCore } from '../../../apps/codex-core/src/main.ts';
import { AccountPoolStore } from '../../../packages/account-pool-host/src/index.ts';
import { createManagedWebServer } from '../../web-deployment/server.mjs';
import { createExecutionDeployment, coreHealth } from '../../server-deployment/execution.mjs';
import { seedLegacyHostStorage, seedNewerHostStorage } from '../../../tests/support/local-agent-storage-fixture.js';
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
  const data = join(root, 'core-data'), state = join(root, 'execution-state');
  await mkdir(join(data, 'runtime'), { recursive: true }); await mkdir(state); await mkdir(join(root, 'home')); await mkdir(join(root, 'native'));
  await writeFile(join(data, 'runtime/config.toml'), '[features]\nplugins = false\n');
  seedLegacyHostStorage(join(state, 'data'));
  const token = 'synthetic-' + 'x'.repeat(48); const tokenPath = join(state, 'daemon.token'); await writeFile(tokenPath, token, { mode: 0o600 });
  const store = new AccountPoolStore({ databasePath: join(data, 'account-pool.sqlite'), secretsDirectory: join(data, 'secrets') });
  store.addAccount({ id: 'fixture', provider: 'codex', label: 'fixture', upstreamAccountId: 'fixture', priority: 1, enabled: true }, { accessToken: 'synthetic-only', refreshToken: null, expiresAt: null }); store.close();
  const calls: any[] = []; let serial = 0;
  const selfUpgrade = process.env.OPENCRAFT_SERVER_SMOKE_SELF_UPGRADE === '1';
  let toolCommand = 'echo started >> shell-count; sleep 30; echo finished >> shell-count; echo UPDATE_TASK_FINISHED';
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const input = JSON.parse((req.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(body) : body).toString('utf8')); const tool = !JSON.stringify(input.input).includes('function_call_output');
    calls.push({ tool, path: req.url });
    res.writeHead(200, { 'content-type': 'text/event-stream' }); const id = `fixture-${++serial}`;
    const send = (event: any) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({ type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } });
    const item = tool ? { id, type: 'function_call', call_id: id, name: 'exec_command', status: 'completed', arguments: JSON.stringify({ cmd: toolCommand, yield_time_ms: 30000, max_output_tokens: 100 }) }
      : { id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'UPDATE_TASK_FINISHED', annotations: [] }] };
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
  let rejectNextStorage = false;
  let core: any, gateway: any, fixture: any, app: any, browser: any; const sockets: WebSocket[] = [];
  const logs: string[] = []; let gatewayPort: number;
  async function stop(child: any) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM'); await until(() => child.exitCode !== null || child.signalCode !== null, 'process exit', 20_000, false);
  }
  async function tree(pid: number): Promise<number[]> {
    try {
      const tasks = await readdir(`/proc/${pid}/task`);
      const children = [...new Set((await Promise.all(tasks.map(t => readFile(`/proc/${pid}/task/${t}/children`, 'utf8').catch(() => '')))).join(' ').split(/\s+/).filter(Boolean).map(Number))];
      return [pid, ...(await Promise.all(children.map(tree))).flat()];
    } catch { return []; }
  }
  function launch(args: string[], extra: any = {}) {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => logs.push(b.toString())); child.stderr.on('data', b => logs.push(b.toString())); return child;
  }
  async function connect(url: string) {
    const socket = new WebSocket(url); sockets.push(socket); const frames: any[] = []; let sequence = 0;
    socket.on('message', b => frames.push(JSON.parse(b.toString()))); await once(socket, 'open');
    const rpc = async (method: string, params: any = {}) => {
      const id = ++sequence; socket.send(JSON.stringify({ id, method, params }));
      const reply = await until(() => frames.find(f => f.id === id && !f.method), method);
      if (reply.error) throw new Error(JSON.stringify(reply.error)); return reply.result;
    };
    await rpc('initialize', { clientInfo: { name: 'update-smoke', version: '1' }, capabilities: { experimentalApi: true } });
    return { socket, rpc, frames };
  }
  try {
    const coreArgs = ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('scripts/smoke/server/smoke-server-updates.ts'), 'core', join(root, 'config.json')];
    if (systemd) {
      await createUnit(coreUnit, [process.execPath, ...coreArgs].join(' ')); control('daemon-reload'); control('start', coreUnit);
      await until(async () => coreHealth(endpoint, tokenPath).catch(() => null), 'systemd core readiness');
    } else {
      core = launch(coreArgs);
      await until(() => logs.some(l => l.includes('core-ready')), 'core readiness');
    }
    // Reserve then release a private port; this test never addresses a user deployment.
    const reserve = createServer(); await new Promise<void>(done => reserve.listen(0, '127.0.0.1', done));
    gatewayPort = (reserve.address() as any).port; await new Promise<void>(done => reserve.close(done));
    fixture = await releaseFixture(root, { execution: true, realWebRoot: resolve('apps/workbench-web/dist') });
    const link = join(root, 'execution-current');
    const gatewayEnv = { OPENCRAFT_EXECUTION_CWD: root, OPENCRAFT_EXECUTION_STATE: state,
      OPENCRAFT_CODEX_CORE_ENDPOINT: endpoint, OPENCRAFT_GATEWAY_PORT: String(gatewayPort), OPENCRAFT_DSH_EXECUTABLE: resolve('runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js') };
    if (systemd) { await createUnit(executionUnit, `${process.execPath} ${link}/execution/gateway.mjs`, gatewayEnv); control('daemon-reload'); }
    const gatewayPid = () => systemd ? Number(control('show', executionUnit, '--property=MainPID', '--value').trim()) : gateway.pid;
    const execution = createExecutionDeployment({ link, unit: executionUnit, coreUnit, coreEndpoint: endpoint, tokenPath,
      healthUrl: `http://127.0.0.1:${gatewayPort}/health`,
      ...(!systemd ? { validate: async () => {}, prepareAccess: async () => {}, restart: async () => {
        await stop(gateway);
        const launchEnv = { ...gatewayEnv };
        if (rejectNextStorage) {
          rejectNextStorage = false;
          const failedState = join(root, 'failed-storage-state'); await mkdir(failedState);
          await writeFile(join(failedState, 'daemon.token'), token, { mode: 0o600 });
          seedNewerHostStorage(join(failedState, 'data'));
          const failedEndpoint = join(failedState, 'direct-check.sock');
          const rejected = spawnSync(process.execPath, [join(await readlink(link), 'execution/daemon.cjs'),
            '--endpoint', failedEndpoint, '--runtime-directory', root,
            '--dsh-executable', gatewayEnv.OPENCRAFT_DSH_EXECUTABLE, '--data-directory', join(failedState, 'data'),
            '--codex-executable', '/external-core-only', '--codex-data-directory', join(failedState, 'codex'),
            '--native-codex-home-directory', join(failedState, 'native')],
            { cwd: root, env: { ...env, OPENCRAFT_DAEMON_AUTH_TOKEN: token }, encoding: 'utf8', timeout: 10_000 });
          assert.equal(rejected.status, 1); assert.match(rejected.stderr, /Host storage executions failed.*newer-schema/);
          await assert.rejects(stat(failedEndpoint), { code: 'ENOENT' });
          launchEnv.OPENCRAFT_EXECUTION_STATE = failedState;
        }
        gateway = launch([join(await readlink(link), 'execution/gateway.mjs')], launchEnv);
      } } : {}) });
    app = await createManagedWebServer({ initialRelease: fixture.releases.get('1.0.0').packageRoot, stateDirectory: join(root, 'web-state'), source: fixture.source, execution,
      codexServerTarget: `ws://127.0.0.1:${gatewayPort}/rpc/codex` });
    const base = `http://127.0.0.1:${(await app.listen({ port: 0 })).port}`;
    if (selfUpgrade) {
      const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
      toolCommand = `echo started >> shell-count && OPENCRAFT_WEB_STATE=${quote(join(root, 'web-state'))} OPENCRAFT_WEB_UPDATE_URL=${quote(base)} OPENCRAFT_WEB_PACKAGE_OUTPUT=${quote(join(root, 'self-built'))} ${quote(process.execPath)} ${quote(resolve('scripts/update-server-local.mjs'))} --version 1.1.0 && echo finished >> shell-count && echo UPDATE_TASK_FINISHED`;
    }
    const initialHealth = await (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).json();
    assert.equal(initialHealth.ok, true);
    assert.deepEqual(Object.fromEntries(initialHealth.storage.map((item: any) => [item.name, item.status])), {
      'session-routing': 'migrated', threads: 'adopted', executions: 'fresh',
      'host-documents': 'fresh', 'managed-connectors': 'adopted', tasks: 'fresh',
    });
    const backupFiles = (await readdir(join(state, 'data'))).filter(name => name.includes('.pre-v1-'));
    const movedAsideFiles = (await readdir(join(state, 'data'))).filter(name => name.includes('.legacy-'));
    assert.equal(backupFiles.length, 3); assert.deepEqual(movedAsideFiles, []);
    const legacyThreads = new DatabaseSync(join(state, 'data/opencraft-threads.sqlite'), { readOnly: true });
    try {
      const row = legacyThreads.prepare('SELECT document FROM opencraft_threads WHERE id = ?').get('legacy-thread');
      assert.equal(JSON.parse(String(row?.document)).manualTitle, 'Legacy title');
    } finally { legacyThreads.close(); }
    for (const item of initialHealth.storage) if (item.backupPath) assert.ok((await stat(item.backupPath)).size > 0);
    const before = await coreHealth(endpoint, tokenPath);
    const A = await connect(base.replace('http:', 'ws:') + '/codex-appserver');
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
    const B = await connect(base.replace('http:', 'ws:') + '/codex-appserver');
    await B.rpc('thread/resume', { threadId });
    const history = await until(async () => { const h = await B.rpc('thread/read', { threadId, includeTurns: true }); return h.thread.turns.some((t: any) => t.id === turnId && t.status === 'completed') ? h : null; }, 'original turn completion', 90_000); assert.match(JSON.stringify(history), /UPDATE_TASK_FINISHED/);
    await until(async () => (await readFile(join(root, 'shell-count'), 'utf8')).includes('finished'), 'shell finished');
    assert.equal(await readFile(join(root, 'shell-count'), 'utf8'), 'started\nfinished\n'); assert.equal(calls.filter(c => c.tool).length, 1);
    if (selfUpgrade) {
      await page.reload();
      await page.getByLabel(/^(Deployment administrator key|部署管理员密钥)$/).fill((await readFile(app.adminKeyPath, 'utf8')).trim());
      await page.getByRole('button', { name: /^(Authorize management|授权管理)$/ }).click();
    }
    await page.getByRole('button', { name: /^(Roll back previous version|回退上一版)$/ }).click();
    await until(async () => { const s = await (await fetch(base + '/__opencraft_updates')).json(); return s.current.version === '1.0.0' && s.job.phase === 'completed'; }, 'browser rollback');
    assert.deepEqual(await coreHealth(endpoint, tokenPath), before);
    const C = await connect(base.replace('http:', 'ws:') + '/codex-appserver');
    const restored = await C.rpc('thread/read', { threadId, includeTurns: true }); assert.match(JSON.stringify(restored), /UPDATE_TASK_FINISHED/);
    const rolledBackHealth = await (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).json();
    assert.equal(rolledBackHealth.ok, true); assert.ok(rolledBackHealth.storage.every((item: any) => item.status === 'up-to-date'));
    // Non-systemd acceptance also launches the real packaged daemon against a separate newer-schema fixture.
    // Its failed startup leaves /health unreachable; the unchanged updater rolls code back to the healthy state.
    let storageFailure: any = null;
    if (!systemd) {
      rejectNextStorage = true;
      const response = await page.request.post(base + '/__opencraft_updates/install', { headers: { origin: base }, data: { version: '1.1.0' } });
      assert.equal(response.status(), 202);
      const failed = await until(async () => {
        const status = await (await fetch(base + '/__opencraft_updates')).json();
        return status.job?.phase === 'failed' ? status : null;
      }, 'storage failure rollback', 120_000);
      assert.match(failed.job.error, /Execution release failed readiness/);
      assert.equal(failed.current.version, '1.0.0');
      await assert.rejects(stat(join(root, 'failed-storage-state', 'daemon.sock')), { code: 'ENOENT' });
      const recovered = await (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).json();
      assert.equal(recovered.ok, true); assert.equal(recovered.version, '1.0.0');
      assert.ok(recovered.storage.every((item: any) => item.status === 'up-to-date'));
      assert.deepEqual(await coreHealth(endpoint, tokenPath), before);
      storageFailure = { error: failed.job.error, rolledBackVersion: recovered.version, storage: recovered.storage, daemonRejectedNewerSchema: true };
    }
    for (const file of [...backupFiles, ...movedAsideFiles]) assert.ok((await stat(join(state, 'data', file))).size > 0);
    const proof = { storageBefore: initialHealth.storage, storageAfterUpgrade: upgradedHealth.storage, storageAfterRollback: rolledBackHealth.storage,
      backupFiles, movedAsideFiles, storageFailure, model: 'gpt-6-luna', at: new Date().toISOString(), cli: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(), threadId, turnId,
      before, after, runningPids: runningTree, afterPids: afterTree, oldGatewayPid, newGatewayPid: gatewayPid(),
      toolCalls: calls.filter(c => c.tool).length, shellExecutions: 1, browserInstall: !selfUpgrade, sourceSelfUpgrade: selfUpgrade, browserRollback: true,
      boundary: `Real npm CLI, production SPA, packaged gateway/daemon and real Codex CLI; synthetic loopback inference; both releases packaged from current source, no N-1 old-binary rollback claim; ${systemd ? 'real isolated systemd units and restart' : 'systemd restart replaced by isolated process restart'}` };
    const output = resolve(process.env.OPENCRAFT_SERVER_UPDATE_EVIDENCE_DIRECTORY || '.local/server-updates'); await mkdir(output, { recursive: true }); await writeFile(join(output, selfUpgrade ? 'self-upgrade-proof.json' : systemd ? 'systemd-proof.json' : 'proof.json'), JSON.stringify(proof, null, 2));
    console.log(JSON.stringify({ ok: true, shellExecutions: 1, originalTurnCompleted: true, corePidsUnchanged: true, browserInstall: !selfUpgrade, sourceSelfUpgrade: selfUpgrade, browserRollback: true, systemd }));
  } catch (error) {
    console.error(logs.join('').slice(-12000)); throw error;
  } finally {
    const cleanupErrors: string[] = [];
    async function clean(label: string, operation: () => any) {
      try { await operation(); } catch (error) { cleanupErrors.push(`${label}: ${String(error)}`); }
    }
    await clean('browser', () => browser?.close());
    for (const socket of sockets) socket.terminate();
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
    } else { await clean('gateway', () => stop(gateway)); await clean('core', () => stop(core)); }
    await clean('registry', () => fixture?.close());
    upstream.closeAllConnections(); await clean('upstream', () => new Promise<void>(done => upstream.close(done)));
    if (cleanupErrors.length === 0) await clean('profile', () => rm(root, { recursive: true, force: true }));
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    if (cleanupErrors.length) throw new Error(`Server update cleanup failed; inspect ${root}: ${cleanupErrors.join('; ')}`);
  }
}
