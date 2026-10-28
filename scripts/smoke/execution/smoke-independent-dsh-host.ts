import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JsonRpcAppServerClient } from '@opencraft/appserver-client';
import { CodexCoreControlClient } from '@opencraft/account-pool-host';
import { startCodexCore } from "../../../apps/codex-core/src/main.js";
import { CodexNativeCoreTransport } from "../../../apps/opencraft-daemon/src/codex-native-core-transport.js";
import { startIndependentDshHost } from "../../server-deployment/dsh-host.mjs";
import { attachDshHost } from "../../server-deployment/dsh-host-client.mjs";
import { createWorkbenchWebServer } from "../../serve-workbench-web.mjs";
import { ModelConfigurationRepository, ModelCredentialRepository } from "../../../apps/local-agent-host/src/model-config/repository.js";

const root = await mkdtemp(join(tmpdir(), 'independent-dsh-'));
let calls = 0;
const trace = join(root, 'tool.txt');
const endpoint = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const agent = Array.isArray(body.tools) && body.tools.length > 0;
  if (agent) calls++;
  const invoke = agent && calls === 1;
  const message = invoke ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-tool', type: 'function',
    function: { name: 'bash', arguments: JSON.stringify({ description: 'Run the isolated continuity fixture', command: `printf 'start\n' >> '${trace}'; sleep 3; printf 'done\n' >> '${trace}'` }) } }] }
    : { role: 'assistant', content: agent ? 'continuity-done' : 'Fixture title' };
  const base = { id: 'fixture', created: 1, model: 'fixture' };
  if (!body.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ...base, choices: [{ message, finish_reason: 'stop' }] })); return; }
  response.setHeader('content-type', 'text/event-stream');
  const chunk = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  response.end(chunk(message) + chunk({}, invoke ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
});
let host: any, web: any, core: any, native: JsonRpcAppServerClient | undefined, socket: WebSocket | undefined;
let rpcId = 0;
const rpc = (method: string, params: any = {}) => new Promise<any>((accept, reject) => {
  const id = ++rpcId, target = socket!;
  const timeout = setTimeout(() => { target.off('message', receive); reject(new Error(method + ' timed out')); }, 15000);
  const receive = (data: WebSocket.RawData) => {
    const frame = JSON.parse(data.toString()); if (frame.id !== id) return;
    clearTimeout(timeout); target.off('message', receive);
    frame.error ? reject(new Error(frame.error.message)) : accept(frame.result);
  };
  target.on('message', receive); target.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
});
async function until(read: () => Promise<any>, label: string) {
  for (let n = 0; n < 200; n++) { if (await read()) return; await delay(50); }
  throw new Error('Timeout: ' + label);
}
try {
  await new Promise<void>(accept => endpoint.listen(0, '127.0.0.1', accept));
  const models = join(root, 'models');
  await new ModelCredentialRepository(models).set('FIXTURE', 'synthetic-key');
  await new ModelConfigurationRepository(models).initialize({ schemaVersion: 1, revision: 0,
    providers: [{ id: 'fixture', name: 'Fixture', protocol: 'openai-completions',
      baseUrl: `http://127.0.0.1:${(endpoint.address() as any).port}/v1`, credentialRef: 'FIXTURE', enabled: true,
      models: [{ id: 'fixture', enabled: true, input: ['text'] }] }], defaultModel: { providerId: 'fixture', modelId: 'fixture' } });
  const dataDirectory = join(root, 'agent'), descriptorPath = join(root, 'descriptor.json');
  const coreToken = 'synthetic-independent-tasks-core-token', tokenFile = join(root, 'core-token');
  await writeFile(tokenFile, coreToken, { mode: 0o600 });
  core = await startCodexCore({ endpoint: join(root, 'core.sock'), authToken: coreToken,
    executable: process.execPath, runtimeDirectory: root, dataDirectory: join(root, 'codex'), nativeCodexHomeDirectory: join(root, 'native'),
    spawnAppServer: ({ args, cwd, env }) => spawn(process.execPath, [new URL("../../../tests/fixtures/fake-codex-unix-appserver.mjs", import.meta.url).pathname, args[2]!.slice('unix://'.length)], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  native = new JsonRpcAppServerClient({ hostId: 'fixture', transport: new CodexNativeCoreTransport(core.endpoint, coreToken) });
  await native.connect({ clientInfo: { name: 'independent-tasks-smoke', version: '1' } });
  const nativeThread = (await native.request('thread/start', { cwd: root })).thread;
  const coreControl = new CodexCoreControlClient(core.endpoint, coreToken);
  const coreIdentity = await coreControl.health();
  const options = { dataDirectory, descriptorPath, modelStorageDirectory: models, skillsDirectory: join(root, 'skills'),
    taskCodexCoreEndpoint: core.endpoint, taskCodexCoreTokenFile: tokenFile,
    projectlessWorkspaceDirectory: join(root, 'workspaces'), runtimeDirectory: root,
    dshExecutable: resolve('runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    dshCapabilityPlugin: resolve('apps/local-agent-host/src/dsh-capability-plugin.mjs') };
  host = await startIndependentDshHost(options);
  const cli = async (command: string, params: unknown = {}) => JSON.parse((await promisify(execFile)(process.execPath, [join(dataDirectory, 'task-agent/opencraft-tasks/scripts/tasks.mjs'), command, JSON.stringify(params)])).stdout);
  const catalog = await cli('conversations', { serverId: 'local-codex' });
  assert.ok(catalog.conversations.some((thread: any) => thread.threadId === nativeThread.id));
  assert.equal(catalog.conversations[0].serverId, 'local-codex');
  assert.doesNotMatch(JSON.stringify(catalog), /turns|cwd|synthetic-independent-tasks-core-token/);
  const enginePid = host.engineProcessId;
  await assert.rejects(startIndependentDshHost(options), /already owned/);
  await assert.rejects(attachDshHost(descriptorPath, join(root, 'wrong')), /incompatible/);
  await assert.rejects(attachDshHost(descriptorPath, dataDirectory, 'foreign-machine'), /incompatible/);
  await chmod(descriptorPath, 0o644);
  await assert.rejects(attachDshHost(descriptorPath, dataDirectory), /private/);
  await chmod(descriptorPath, 0o600);
  const staticRoot = join(root, 'web'); await mkdir(staticRoot);
  await writeFile(join(staticRoot, 'index.html'), '<html><head></head><body>fixture</body></html>');
  const connect = async () => {
    const attachment = await attachDshHost(descriptorPath, dataDirectory);
    assert.equal(attachment.identity.enginePid, enginePid);
    web = await createWorkbenchWebServer({ root: staticRoot, appServerTarget: attachment.websocketUrl,
      resolveAppServerTarget: attachment.resolveWebsocketUrl,
      getExecutionHealth: async () => ({ ok: true, dsh: await attachment.getIdentity() }) });
    const address = await web.listen({ host: '127.0.0.1', port: 0 });
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/appserver`);
    await new Promise<void>((accept, reject) => { socket!.once('open', accept); socket!.once('error', reject); });
    await rpc('initialize'); return attachment;
  };
  const attachment = await connect();
  // The original failure: the real page starts a thread with no cwd/project.
  const created = await rpc('thread/start', { dynamicTools: [], runtimeWorkspaceRoots: [], permissions: 'danger-full-access' });
  assert.ok(created.thread.cwd.startsWith(join(root, 'workspaces')));
  const threadId = created.thread.id;
  await cli('member', { id: 'sam', name: 'Sam', expectedRevision: null });
  await cli('create', { id: 'continuity-task', title: 'Preserve team task', assigneeId: 'sam', priority: 'high', dueDate: '2026-12-15' });
  await cli('link', { id: 'continuity-task', expectedRevision: 1, serverId: 'local-codex', threadId: nativeThread.id });
  await cli('link', { id: 'continuity-task', expectedRevision: 2, serverId: 'opencraft-server', threadId });
  const { turn } = await rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Run the fixture tool once.' }] });
  await until(async () => (await readFile(trace, 'utf8').catch(() => '')) === 'start\n', 'native bash started');
  socket!.terminate(); await web.close(); web = undefined;
  await attachment.close(); // A versioned gateway releases its connection, not the Host.
  assert.equal(host.engineProcessId, enginePid);
  assert.equal((await cli('read', { id: 'continuity-task' })).conversations.length, 2);
  await connect(); await rpc('thread/resume', { threadId });
  let history: any;
  await until(async () => {
    history = (await rpc('thread/read', { threadId, includeTurns: true })).thread;
    return history.turns.some((value: any) => value.id === turn.id && value.status === 'completed');
  }, 'original turn completed after gateway replacement');
  assert.equal(await readFile(trace, 'utf8'), 'start\ndone\n');
  assert.equal(calls, 2, 'one tool request and one final answer; no replay');
  assert.match(JSON.stringify(history), /continuity-done/);
  const resumeParams = { threadId, excludeTurns: true, initialTurnsPage: { limit: 5, sortDirection: 'desc', itemsView: 'full' } };
  const initialRecovery = await rpc('thread/resume', resumeParams);
  const unchanged = await rpc('thread/resume', { ...resumeParams, historyCheckpoint: initialRecovery.historyRecovery.checkpoint });
  assert.equal(unchanged.historyRecovery.mode, 'unchanged');
  assert.equal(unchanged.historyMetrics.nativeReads, 0, 'real native describe head eliminates history RPC');
  assert.equal(unchanged.historyMetrics.nativeEvents, 0);
  assert.equal(unchanged.initialTurnsPage.data.length, 0);
  assert.equal(host.engineProcessId, enginePid);
  // Fault recovery differs from update continuity: health and reconnect follow a new generation.
  const gateway = `http://127.0.0.1:${web.server.address().port}`;
  const ownerBeforeCrash = host.handoff.authority.snapshot();
  process.kill(enginePid, 'SIGKILL');
  await until(async () => {
    const response = await fetch(gateway + '/health');
    const health = await response.json();
    return response.ok && health.dsh?.enginePid !== enginePid;
  }, 'health recovers after automatic engine restart');
  assert.equal(host.handoff.open(), true);
  assert.equal(host.handoff.authority.snapshot().epoch, ownerBeforeCrash.epoch, 'ordinary crash does not create a handoff fence');
  const previousUrl = host.websocketUrl;
  socket!.terminate(); await host.close(); host = undefined;
  host = await startIndependentDshHost(options);
  assert.notEqual(host.websocketUrl, previousUrl, 'new Host has a new endpoint/token');
  const response = await fetch(gateway + '/health');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).dsh.enginePid, host.engineProcessId);
  socket = new WebSocket(gateway.replace('http:', 'ws:') + '/appserver');
  await new Promise<void>((accept, reject) => { socket!.once('open', accept); socket!.once('error', reject); });
  await rpc('initialize');
  const recovered = await rpc('thread/read', { threadId, includeTurns: true });
  assert.equal(recovered.thread.id, threadId);
  assert.match(JSON.stringify(recovered), /continuity-done/);
  assert.equal(calls, 2, 'recovery must not replay completed model requests');
  const task = await cli('read', { id: 'continuity-task' });
  assert.equal(task.assigneeId, 'sam'); assert.equal(task.conversations.length, 2); assert.equal(task.priority, 'high');
  assert.ok((await cli('conversations', { serverId: 'local-codex' })).conversations.some((thread: any) => thread.threadId === nativeThread.id));
  assert.deepEqual(await coreControl.health(), coreIdentity);
  console.log(JSON.stringify({ status: 'passed', projectlessCreation: true, nativeToolExecutions: 1, modelCalls: calls, unchangedHistoryReads: unchanged.historyMetrics.nativeReads,
    enginePidUnchangedDuringUpdate: true, engineRestartRecoversHealth: true, hostRestartReconnectsSameGateway: true,
    tasks: { splitCoreCatalog: true, crossEngineLinks: true, propertiesSurviveHostRestart: true, corePidUnchanged: true, nativeEngine: 'fixture', dshEngine: 'real' } }));
} finally {
  socket?.terminate(); await web?.close(); await host?.close();
  await native?.close(); await core?.close();
  endpoint.closeAllConnections(); await new Promise<void>(accept => endpoint.close(() => accept()));
  await rm(root, { recursive: true, force: true });
}
