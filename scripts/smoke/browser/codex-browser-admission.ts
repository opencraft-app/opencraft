import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { openServerDatabase } from '../../../packages/storage-node/src/server/index.js';
import { ActorStore } from '../../../packages/access-control/src/actors.js';
import { Collaboration } from '../../../packages/access-control/src/collaboration.js';
import { OrchestrationRuntimeWorker } from '../../../packages/access-control/src/orchestration-runtime-store.js';
import { SessionCapabilities } from '../../../packages/session-capabilities/src/index.js';
import { SessionCapabilityMcp } from '../../../packages/session-capabilities/src/mcp.js';
import { createBrowserGrantResolver } from '../../../apps/headless-server/src/remote-browser/execution-grant.js';
import { RemoteBrowserCapabilities } from '../../../apps/headless-server/src/remote-browser/capabilities.js';
import { CodexBridgeRuntime } from '../../../apps/agent-bridge-host/src/codex-runtime.js';
import { randomBytes } from 'node:crypto';

/** Local model responses are synthetic. Execution identity, native turn history,
 * persisted human admission, Worker SQL, revocation and browser effects are real. */
export async function runCodexBrowserAdmission(directory: string, browser: ConstructorParameters<typeof RemoteBrowserCapabilities>[1], ownerId: string, hostId: string, foreignTabId: string, url: string) {
  const home = join(directory, 'codex-admission'), serverId = 'browser-admission-server';
  await mkdir(home, { recursive: true });
  const database = await openServerDatabase(home), actors = new ActorStore(database);
  const human = actors.resolveHuman({ provider: 'local-acceptance', subject: 'operator', displayName: 'Acceptance operator', expiresAt: Date.now() + 120000 })!;
  const worker = new OrchestrationRuntimeWorker(join(home, 'opencraft-server.sqlite')); await worker.start();
  const collaboration = new Collaboration(database, actors, { serverId, hostId, async validate() {}, async receipt() { return null; },
    async add() { throw Error('Not used by this browser acceptance'); }, async steer() { throw Error('Not used by this browser acceptance'); }, async cancel() { return false; },
  }, Date.now, () => true, worker);
  const capabilities = new SessionCapabilities(), mcp = new SessionCapabilityMcp(capabilities, randomBytes(32));
  let reservation: ReturnType<SessionCapabilityMcp['prepareExecution']> | undefined;
  let threadId = '', turnId = '', tabId = '', nativePageId = '', phase = 'primer', step = 0, fault: Error | undefined;
  let sourceChecks = 0, nativeChecks = 0, sequence = 0, carry = '', stderr = '';
  const frames: any[] = [], bridgeFrames: any[] = [];
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let child: ReturnType<typeof spawn> | undefined;
  const request = (method: string, params: any): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('Native CLI request timed out: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer }); child!.stdin!.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const bridge = new CodexBridgeRuntime({ request, resolve() {} }, frame => bridgeFrames.push(frame));
  const provider = new RemoteBrowserCapabilities(capabilities, browser, createBrowserGrantResolver({
    serverForThread: () => serverId, hostForServer: () => hostId,
    source: async (id, execution) => { sourceChecks++; return collaboration.executionContext(id, execution); },
    authorize: context => { if (!actors.isCurrent(context) || context.actorId !== human.actorId) throw Error('Browser authority revoked'); },
    owner: () => ownerId,
    currentTurn: async (_host, id) => {
      nativeChecks++;
      const requestId = 'latest-' + nativeChecks;
      await bridge.handle({ jsonrpc: '2.0', id: requestId, method: 'history/read', params: {
        threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
      } });
      const frame: any = bridgeFrames.find((f: any) => f.id === requestId); assert(!frame.error, JSON.stringify(frame.error));
      assert.equal(frame.result.data.length, 1); assert(frame.result.nextCursor, 'Native history must contain the earlier completed turn');
      return frame.result.data[0];
    },
  }));
  function output(body: any, id: number): any {
    const item = body.input.findLast((v: any) => v.type === 'function_call_output' && v.call_id === 'admission-' + id);
    assert(item, 'Native CLI must return the MCP result to the model'); return item.output;
  }
  function structured(value: any): any {
    if (typeof value === 'string') { try { return structured(JSON.parse(value)); } catch { return null; } }
    if (Array.isArray(value)) return value.map(structured).find(Boolean);
    if (value?.tabId || value?.tabs) return value;
    if (value?.text) return structured(value.text);
    return null;
  }
  const use = (action: string) => ({ name: 'opencraft_browser_browser_use', arguments: { action, ...(action === 'list_tabs' ? {} : { tab_id: tabId }) } });
  const model = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks), encoding = req.headers['content-encoding'];
      const body = JSON.parse((encoding === 'zstd' ? zstdDecompressSync(raw) : encoding === 'gzip' ? gunzipSync(raw) : raw).toString());
      let next: any;
      if (phase !== 'primer') {
        if (step === 0) next = { name: 'opencraft_app_open_in_opencraft', arguments: { url, visible: false } };
        if (step === 1) { tabId = structured(output(body, 0))?.tabId; assert(tabId); nativePageId = [...(browser as any).pages.values()].find((p: any) => p.link?.tabId === tabId).id; next = use('inspect'); }
        if (step === 2) { assert(Array.isArray(structured(output(body, 1))?.elements)); next = { name: 'opencraft_browser_browser_use', arguments: { action: 'inspect', tab_id: foreignTabId } }; }
        if (step === 3) { assert(JSON.stringify(output(body, 2)).includes('TAB_ACCESS_DENIED')); next = use('close'); }
        if (step === 4) { assert.equal(structured(output(body, 3))?.closed, true); next = use('list_tabs'); }
        if (step === 5) {
          assert(!structured(output(body, 4)).tabs.some((t: any) => t.tabId === tabId));
          actors.setEnabled(human.actorId, false, human.actorId); next = use('list_tabs');
        }
        if (step === 6) assert(JSON.stringify(output(body, 5)).includes('Capability denied or failed'), 'Revoked execution must be denied through MCP');
        assert(step <= 6); step++;
      }
      const id = 'admission-response-' + phase + '-' + step;
      const item = next ? { type: 'function_call', id: 'item-' + step, call_id: 'admission-' + (step - 1), namespace: 'mcp__browser',
        name: next.name, arguments: JSON.stringify(next.arguments), status: 'completed' }
        : { type: 'message', id: 'final-' + phase, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ADMISSION_' + phase + '_OK', annotations: [] }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [{ type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]) res.write('data: ' + JSON.stringify(event) + '\n\n');
      res.end();
    } catch (error) { fault ??= error as Error; res.writeHead(500); res.end('Admission acceptance failed'); }
  });
  const until = async (predicate: () => boolean) => { const end = Date.now() + 30000; while (!predicate()) { if (fault) throw fault; assert(Date.now() < end, 'Native CLI event timed out: ' + stderr.slice(-1000)); await new Promise(resolve => setTimeout(resolve, 20)); } };
  try {
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
    await mcp.listen();
    reservation = mcp.prepareExecution({ memoryOnly: true });
    const port = (model.address() as { port: number }).port;
    await writeFile(join(home, 'config.toml'), ['model="browser-fixture"', 'model_provider="local_fixture"', 'approval_policy="never"', 'sandbox_mode="read-only"',
      '[model_providers.local_fixture]', 'name="Local acceptance"', `base_url="http://127.0.0.1:${port}/v1"`, 'wire_api="responses"',
      'requires_openai_auth=false', 'supports_websockets=false', 'request_max_retries=0', 'stream_max_retries=0'].join('\n'), { mode: 0o600 });
    child = spawn(process.env.OPENCRAFT_CODEX_EXECUTABLE ?? 'codex', ['app-server', '--stdio'], { env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('error', error => { fault ??= error; });
    child.stderr!.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.stdout!.on('data', chunk => {
      carry += chunk;
      for (;;) {
        const end = carry.indexOf('\n'); if (end < 0) break;
        const frame = JSON.parse(carry.slice(0, end)); carry = carry.slice(end + 1); frames.push(frame);
        if (frame.method === 'turn/started') { turnId = frame.params.turn.id; if (phase !== 'primer') collaboration.executionStarted(threadId, 'browser-input', turnId); }
        const call = pending.get(frame.id);
        if (call) { pending.delete(frame.id); clearTimeout(call.timer); frame.error ? call.reject(Error(JSON.stringify(frame.error))) : call.resolve(frame.result); }
      }
    });
    await request('initialize', { clientInfo: { name: 'browser-admission', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin!.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    // Install an unbound credential at creation, then bind its human input
    // before dispatch. Listing may precede native execution; invocation may not.
    const config = { ...reservation.configuration, tools: Object.fromEntries([
      'opencraft_app_open_in_opencraft', 'opencraft_browser_browser_use', 'opencraft_browser_get_tab_context',
    ].map(name => [name, { approval_mode: 'approve' }])) };
    threadId = (await request('thread/start', { cwd: home, model: 'browser-fixture', approvalPolicy: 'never', sandbox: 'read-only',
      config: { 'mcp_servers.browser': config },
    })).thread.id;
    collaboration.authorizeExecution(human, threadId, 'browser-input');
    reservation.bindThread({ serverId, threadId });
    reservation.bind({ serverId, threadId, execution: { inputId: 'browser-input', executionId: 'browser-input' } });
    await request('turn/start', { threadId, input: [{ type: 'text', text: 'Primer turn for multi-turn browser admission.' }] });
    await until(() => frames.some(f => f.method === 'turn/completed'));
    assert.equal(frames.find(f => f.method === 'turn/completed').params.turn.status, 'completed');
    await bridge.handle({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: 1, grammarRange: { min: 1, max: 1 } } });
    bridge.adapter.bind(threadId, threadId);
    phase = 'browser';
    await request('turn/start', { threadId, clientUserMessageId: 'browser-input', input: [{ type: 'text', text: 'Exercise admitted browser tools and human revocation.' }] });
    await until(() => frames.filter(f => f.method === 'turn/completed').length === 2);
    if (fault) throw fault;
    assert.equal(frames.filter(f => f.method === 'turn/completed').at(-1).params.turn.status, 'completed');
    assert.equal(step, 7); assert(sourceChecks >= 10 && nativeChecks >= 5);
    const history = await request('thread/turns/list', { threadId, limit: 100, sortDirection: 'desc', itemsView: 'notLoaded' });
    assert.equal(history.data.length, 2); assert.equal(history.data[0].id, turnId);
    assert(!(await (browser as any).request(undefined, 'inventory')).some((p: any) => p.id === nativePageId));
    const evidence = { cliMode: 'app-server --stdio', model: 'synthetic loopback Responses only',
      executionAuthority: 'ActorStore + Collaboration + Worker SQL + createBrowserGrantResolver', nativeThread: threadId, nativeTurn: turnId,
      nativeHistoryTurns: history.data.length, sourceChecks, nativeChecks, nativeCloseConfirmed: true,
      checks: ['multi-turn-native-history', 'persisted-human-input-authority', 'exact-active-native-turn', 'admitted-create-inspect-close',
        'existing-other-conversation-tab-denied', 'human-revocation-denied-via-MCP'] };
    await writeFile(join(directory, 'codex-browser-admission-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log('CODEX_BROWSER_ADMISSION_OK: ' + JSON.stringify(evidence)); return evidence;
  } finally {
    if (child) { child.stdin!.end(); child.kill('SIGTERM'); }
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(Error('Acceptance closed')); } pending.clear();
    reservation?.cancel(); await provider.close(); await mcp.close(); await collaboration.close(); await worker.close(); actors.close(); await database.close();
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(join(home, 'config.toml'), { force: true });
  }
}
