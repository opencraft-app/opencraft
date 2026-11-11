import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { build } from 'esbuild';
import { BridgeHost } from '../../../apps/agent-bridge-host/src/host.js';
import { attachGateway } from '../../../apps/agent-bridge-host/src/server.js';
import { codexDeclaration } from '../../../apps/agent-bridge-host/src/codex-declaration.js';
import { CodexProviderBridge } from '../../../apps/opencraft-daemon/src/codex-provider-bridge.js';
import { localTestBackend } from './local-backend.js';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';

/** Browser acceptance fixture. Native/model boundaries are synthetic; the pinned
 * bridge, sandbox API, Host, SQL Worker, inbox and daemon composition are real. */
export async function createCodexPreview() {
  const root = await mkdtemp(join(tmpdir(), 'codex-p2a-browser-'));
  const token = 'synthetic-preview-token-000000000000000';
  const nativeId = 'native-preview', publicId = 'bridge:codex:preview', nativeTurn = 'preview-turn';
  const metadata = (id: string, name: string, active = false) => ({ id, sessionId: id, name, preview: name, modelProvider: 'openai', model: 'fixture-model', cwd: '/remote', createdAt: 1_800_000_000, updatedAt: 1_800_000_001, historyMode: 'paginated', status: active ? { type: 'active', activeFlags: [] } : { type: 'idle' }, turns: [], source: 'appServer', cliVersion: 'fixture' });
  const oldItem = { type: 'agentMessage', id: 'old-answer', text: 'Old bridge fixture answer', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null };
  const oldTurn = { id: 'old-turn', status: 'completed', error: null, startedAt: 1_800_000_000, completedAt: 1_800_000_001, durationMs: 1000, itemsView: 'full', items: [{ type: 'userMessage', id: 'old-user', clientId: null, content: [{ type: 'text', text: 'Old fixture question', text_elements: [] }] }, oldItem] };
  const old = () => ({ ...metadata('legacy-preview', 'Legacy preview'), turns: [oldTurn] });
  let active = false, started = false, starts = 0, steers = 0, pendingInput: any;
  const items: any[] = [], peers = new Set<WebSocket>();
  const turn = () => ({ id: nativeTurn, rootTurnId: nativeTurn, status: active ? 'inProgress' : 'completed', error: null, itemsView: 'full', startedAt: 1_800_000_000, completedAt: active ? null : 1_800_000_001, durationMs: active ? null : 1000, items });
  const thread = () => ({ ...metadata(nativeId, 'Codex bridge preview', active), turns: started ? [turn()] : [] });
  const emit = (method: string, params: unknown) => { for (const socket of peers) socket.send(JSON.stringify({ method, params })); };
  const itemEvent = (method: string, item: unknown) => emit(method, { threadId: nativeId, turnId: nativeTurn, item });
  const base = (method: string, p: any): any => {
    const target = p.threadId === 'legacy-preview' ? old() : thread();
    switch (method) {
      case 'opencraft/agents/onboarding/status': return { agents: [{ id: 'codex', installed: true, authenticated: true, account: null, activity: null, version: 'fixture', installUrl: 'https://example.invalid', canInstallPackage: false }] };
      case 'opencraft/agents/onboarding/models': return { models: [{ id: 'fixture-model', name: 'Fixture model' }] };
      case 'initialize': return { userAgent: 'codex/0.167.0', capabilities: {} };
      case 'runtime/machine/read': return { machine: { machineId: '22345678-1234-4123-8123-123456789abc', name: 'Bridge UI fixture', platform: 'linux' }, agent: 'Codex' };
      case 'model/list': return { data: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture model', description: 'Synthetic model', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Fixture' }], defaultReasoningEffort: 'medium', inputModalities: ['text'], supportsPersonality: false, additionalSpeedTiers: [], serviceTiers: [] }], nextCursor: null };
      case 'thread/list': return { data: [metadata('legacy-preview', 'Legacy preview'), metadata(nativeId, 'Codex bridge preview', active)], nextCursor: null };
      case 'threadSection/list': return { data: [], nextCursor: null };
      case 'thread/read': return { thread: target };
      case 'thread/start': return { thread: thread(), model: 'fixture-model', modelProvider: 'openai' };
      case 'thread/resume': return { thread: { ...target, turns: [] }, model: 'fixture-model', modelProvider: 'openai', cwd: '/remote', runtimeWorkspaceRoots: ['/remote'], instructionSources: [], serviceTier: null, disabledPluginIds: [], approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly' }, activePermissionProfile: null, reasoningEffort: 'medium', collaborationMode: null, multiAgentMode: 'explicitRequestOnly', initialTurnsPage: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
      case 'thread/turns/list': return { data: target.turns, nextCursor: null, backwardsCursor: null };
      case 'thread/items/list': return { data: (target.turns.find(t => t.id === p.turnId)?.items ?? []).map(item => ({ turnId: p.turnId, item })), nextCursor: null, backwardsCursor: null };
      case 'skills/list': return { data: [{ cwd: '/remote', skills: [], errors: [] }] };
      case 'thread/loaded/list': return { data: [] };
      case 'config/read': return { config: { model: 'fixture-model', model_provider: 'openai' }, origins: {}, layers: null };
      case 'configRequirements/read': return { requirements: null };
      case 'permissionProfile/list': return { data: [], nextCursor: null };
      case 'thread/unsubscribe': return {};
      default: return undefined;
    }
  };
  const native = createServer(), control = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    response.end(JSON.stringify(request.url === '/launch' ? { dataDirectory: root, launch: { args: [], env: { OPENCRAFT_CODEX_POOL_AUTH_TOKEN: 'synthetic' }, auth: { type: 'chatgptAuthTokens', accessToken: 'synthetic', chatgptAccountId: 'opencraft-account-pool' } } } : { protocolVersion: 1, pid: process.pid, codexPid: process.pid, nativeSocket: join(root, 'native.sock') }));
  });
  const ws = new WebSocketServer({ server: native });
  ws.on('connection', socket => { peers.add(socket); socket.on('close', () => peers.delete(socket)); socket.on('message', raw => {
    const f = JSON.parse(String(raw)), p = f.params ?? {};
    if (f.id === undefined) return;
    let result = base(f.method, p);
    if (f.method === 'turn/start') {
      starts++; started = active = true;
      emit('turn/started', { threadId: nativeId, turn: { ...turn(), items: [] } });
      const user = { type: 'userMessage', id: 'native-user', clientId: p.clientUserMessageId, content: p.input };
      items.push(user); itemEvent('item/started', user); itemEvent('item/completed', user);
      const tool = { type: 'commandExecution', id: 'native-tool', command: 'cat fixture.txt', cwd: '/remote', status: 'inProgress', aggregatedOutput: null };
      items.push(tool); itemEvent('item/started', tool); result = { turn: { ...turn(), items: [] } };
    }
    if (f.method === 'turn/steer') { steers++; pendingInput = { type: 'userMessage', id: 'native-steer', clientId: p.clientUserMessageId, content: p.input }; result = { turnId: nativeTurn }; }
    socket.send(JSON.stringify(result === undefined ? { id: f.id, error: { code: -32601, message: 'Unsupported fixture method' } } : { id: f.id, result }));
  }); });
  await new Promise<void>(r => native.listen(join(root, 'native.sock'), r));
  await new Promise<void>(r => control.listen(join(root, 'control.sock'), r));
  await writeFile(join(root, 'core.json'), JSON.stringify({ endpoint: join(root, 'control.sock'), token }), { mode: 0o600 });
  const artifact = join(root, 'codex.cjs');
  await build({ entryPoints: [resolve('apps/agent-bridge-host/src/codex-main.ts')], outfile: artifact, bundle: true, platform: 'node', format: 'cjs' });
  const host = await BridgeHost.open({ path: join(root, 'host.db'), policy: { id: 'p2a-browser', capacity: { cpuMillis: 16000, memoryBytes: 32 * 1024 ** 3 } }, backend: localTestBackend() });
  const endpoint = await attachGateway(host, token);
  await host.add({ id: 'preview', artifact, digest: createHash('sha256').update(await readFile(artifact)).digest('hex'), provider: codexDeclaration, launch: { command: [process.execPath, artifact, join(root, 'core.json')], cwd: root, env: {} } });
  await host.activate('preview', '');
  const createTransport = () => {
    let listener: (raw: string) => void = () => {};
    const legacy = { status: { state: 'open' as const }, async connect() {}, async close() {}, subscribeStatus() { return () => {}; }, subscribeMessage(callback: (raw: string) => void) { listener = callback; return () => {}; },
      async send(raw: string) { const f = JSON.parse(raw); if (f.id === undefined) return; const result = base(f.method, f.params ?? {}); listener(JSON.stringify({ id: f.id, [LOGICAL_CLIENT_FIELD]: f[LOGICAL_CLIENT_FIELD], ...(result === undefined ? { error: { code: -32601, message: 'Unsupported fixture method' } } : { result }) })); },
    };
    return new CodexProviderBridge(legacy, { url: endpoint.url, token, serverId: 'preview-server', inboxPath: join(root, 'gateway.db') });
  };
  return { publicId, createTransport, gatewayOptions: { url: endpoint.url, token, serverId: 'preview-server', inboxPath: join(root, 'gateway.db') }, counts: () => ({ starts, steers }),
    confirm() { if (!pendingInput) throw Error('No pending fixture steer'); items.push(pendingInput); itemEvent('item/started', pendingInput); itemEvent('item/completed', pendingInput); pendingInput = undefined; },
    finish() { active = false; const tool = items.find(i => i.type === 'commandExecution'); Object.assign(tool, { status: 'completed', aggregatedOutput: 'P2a fixture tool output' }); itemEvent('item/completed', tool); const answer = { type: 'agentMessage', id: 'native-answer', text: 'P2a bridge fixture completed', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null }; items.push(answer); itemEvent('item/started', answer); itemEvent('item/completed', answer); emit('turn/completed', { threadId: nativeId, turn: turn() }); },
    async close() { await endpoint.close(); await host.close(); ws.close(); await Promise.all([new Promise<void>(r => native.close(() => r())), new Promise<void>(r => control.close(() => r()))]); await rm(root, { recursive: true, force: true }); },
  };
}
