import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CodexEngineAdapter } from '../../../apps/opencraft-daemon/src/codex-engine-adapter.js';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { chromium } from 'playwright';
import { createServer as createVite } from 'vite';
import { createWorkbenchWebConfig } from '../../../apps/workbench-web/vite.config.js';
import { startHeadlessServer } from '../../../apps/headless-server/src/headless-server.mjs';
import { createWorkbenchWebServer } from '../../../apps/headless-server/src/serve-workbench-web.mjs';
import { packageBrowserRuntime } from '../../package-browser-runtime.mjs';
import {createLoopbackSshFixture} from './ssh-loopback-fixture.js';

// Real product/account/Host/Codex/Electron composition. Only inference and the
// unused second engine endpoint are fixtures; all data belongs to this profile.
const directory = await mkdtemp(join(tmpdir(), 'codex-browser-product-'));
const touch = process.argv.includes('--touch');
const networkSsh = process.argv.includes('--ssh-network');
const remote = networkSsh || process.argv.includes('--ssh-proxy');
const hostId = remote ? 'ssh:acceptance' : 'local-codex';
const executable = process.env.OPENCRAFT_CODEX_EXECUTABLE ?? 'codex';
const data = join(directory, 'data'), webRoot = join(directory, 'web'), home = join(data, 'native-codex');
await mkdir(data, { mode: 0o700 });
await Promise.all([mkdir(webRoot), mkdir(home, { recursive: true })]);
await writeFile(join(webRoot, 'index.html'), '<title>Browser acceptance</title>');
await writeFile(join(webRoot, 'version.json'), JSON.stringify({ schemaVersion: 1, buildId: 'codex-browser-product', headlessServer: true, headlessHostId: 'opencraft-server' }));
await packageBrowserRuntime(join(directory, 'runtime/browser'));
let step = 0, tabId = '', demoUrl = '', modelFault: unknown, toolFault: unknown;
const nativeCalls: Array<{ threadId: string; turnId: string; callId: string; namespace?: string | null; name: string }> = [];
let rejectInference!: (error: unknown) => void;
const inferenceFailure = new Promise<never>((_resolve, reject) => { rejectInference = reject; }); void inferenceFailure.catch(() => {});
let releaseDraft!: () => void;
const draftReady = new Promise<void>(resolve => { releaseDraft = resolve; });
let nativeWaits = 0, waitAborted = false, waitSettled = false, nativeReplyObserved = false;
let deniedPostRevocation = false, unauthorizedNativeWrites = 0, revoked = false;
let fieldRef: string, fieldRevision: number;
const nativeWaitRequests = new Set<string>();
const until = async (ready: () => boolean, message: string) => {
  const deadline = Date.now() + 15000;
  while (!ready()) { if (modelFault) throw modelFault; assert(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const structured = (value: any): any => {
  if (typeof value === 'string') { try { return structured(JSON.parse(value)); } catch { return null; } }
  if (Array.isArray(value)) return value.map(structured).find(Boolean);
  if (value?.tabId || value?.elements) return value;
  return value?.text ? structured(value.text) : null;
};
const model = createServer(async (req, res) => {
  try {
    if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
      if (req.url?.endsWith('/models')) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'browser-fixture', object: 'model', owned_by: 'fixture' }] }));
      else res.writeHead(404).end(); return;
    }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks), encoding = req.headers['content-encoding'];
    const body = JSON.parse((encoding === 'zstd' ? zstdDecompressSync(raw) : encoding === 'gzip' ? gunzipSync(raw) : raw).toString());
    const output = (index: number) => body.input.findLast((item: any) => item.type === 'function_call_output' && item.call_id === `product-${index}`)?.output;
    let next: any;
    if (step === 0) { await draftReady; next = { name: 'opencraft_app_open_in_opencraft', args: { url: demoUrl, visible: true } }; }
    else if (step === 1) { const opened = structured(output(0)); assert.equal(opened?.visible, true); tabId = opened.tabId; next = { name: 'opencraft_browser_browser_use', args: { action: 'inspect', tab_id: tabId } }; }
    else if (step === 2) { const inspection = structured(output(1)), field = inspection?.elements.find((item: any) => item.name === 'Name'); assert(field); fieldRef = field.ref; fieldRevision = inspection.revision; next = { name: 'opencraft_browser_browser_use', args: { action: 'screenshot', tab_id: tabId } }; }
    else if (step === 3) {
      const value = output(2), image = Array.isArray(value) ? value.find(item => item.type === 'input_image')?.image_url : undefined;
      assert.equal(typeof image, 'string', 'native image must remain a typed model input');
      assert.equal(Buffer.from(image.split(',')[1], 'base64').subarray(1, 4).toString(), 'PNG');
    }
    else if (step === 4) next = { name: 'opencraft_browser_browser_use', args: { action: 'wait', tab_id: tabId, text: 'product-revocation-never-present', timeout_ms: 60000 } };
    else if (step === 5) { assert(waitAborted && waitSettled && nativeReplyObserved); assert.equal(nativeWaits, 1);
      next = { name: 'opencraft_browser_browser_use', args: { action: 'fill', tab_id: tabId, expected_revision: fieldRevision, ref: fieldRef, value: 'must-not-apply-after-revocation' } };
    }
    else if (step === 6) { assert(JSON.stringify(output(5)).includes('unavailable or unauthorized')); deniedPostRevocation = true; }
    else assert.fail('Unexpected product model request');
    const id = `product-${step++}`;
    const namespace = next?.name.startsWith('opencraft_app_') ? 'opencraft_app' : 'opencraft_browser';
    const item = next ? { type: 'function_call', id: 'item-' + id, call_id: id, namespace, name: next.name.slice(namespace.length + 1), arguments: JSON.stringify(next.args), status: 'completed' }
      : { type: 'message', id: 'final', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'CODEX_BROWSER_PRODUCT_OK', annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [{ type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]) res.write('data: ' + JSON.stringify(event) + '\n\n');
    res.end();
  } catch (error) { modelFault ??= error; rejectInference(error); res.writeHead(500).end(); }
});
let app: any, assembly: any, vite: Awaited<ReturnType<typeof createVite>> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let nativeServer: ReturnType<typeof spawn> | undefined, proxyConnections = 0;
let sshFixture: Awaited<ReturnType<typeof createLoopbackSshFixture>> | undefined;
try {
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  await writeFile(join(home, 'config.toml'), ['model="browser-fixture"', 'thread_unload_delay_secs=1', 'model_provider="local_fixture"', 'approval_policy="never"', 'sandbox_mode="read-only"',
    '[model_providers.local_fixture]', 'name="Product acceptance"', `base_url="http://127.0.0.1:${(model.address() as any).port}/v1"`, 'wire_api="responses"',
    'requires_openai_auth=false', 'supports_websockets=false', 'request_max_retries=0', 'stream_max_retries=0'].join('\n'), { mode: 0o600 });
  const socketPath = join(directory, 'native.sock');
  if (remote) {
    assert(executable.startsWith('/'), 'SSH probe requires an explicit absolute Codex executable');
    nativeServer = spawn(executable, ['app-server', '--listen', `unix://${socketPath}`], {env:{...process.env,CODEX_HOME:home},stdio:['ignore','pipe','pipe']});
    nativeServer.stdout!.resume(); nativeServer.stderr!.resume();
    await until(() => { assert.equal(nativeServer!.exitCode, null, 'Isolated native server exited before opening its socket'); return existsSync(socketPath); }, 'Native proxy socket missing');
    if(networkSsh) sshFixture=await createLoopbackSshFixture(directory);
  }
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = (reserve.address() as any).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`, config = join(directory, 'human-auth.json'), setupTokenFile = join(directory, 'setup.json'), proof = randomBytes(32).toString('base64url');
  await writeFile(setupTokenFile, JSON.stringify({ token: proof }), { mode: 0o600 });
  await writeFile(config, JSON.stringify({ origin, local: true, oidc: [], setupTokenFile }), { mode: 0o600 });
  app = await startHeadlessServer({ root: directory, webRoot, dataDirectory: data, port, humanAuthConfig: config,
    codexExecutable: executable,
    ...(remote ? {sshServers:[{descriptor:{serverId:hostId,displayName:'Native proxy acceptance',workspaceBrowseRoots:[directory]},connection:{
      hostname:'fixture.invalid',port:22,username:'fixture',knownHostsFile:join(directory,'fixture-known-hosts'),authentication:{kind:'agent'},
      ...sshFixture?.connection,
      codexExecutable:executable,codexHome:home,socketPath,
      // Only OpenSSH exec is substituted. The production sentinel/WebSocket
      // transport and actual Codex app-server proxy/native server are retained.
      spawnSsh:(args,env) => { proxyConnections++; return networkSsh ? spawn('ssh',args,{env,stdio:['pipe','pipe','pipe']})
        : spawn('/bin/sh',['-c',args.at(-1)],{env:{...env,SHELL:'/bin/sh'},stdio:['pipe','pipe','pipe']}); },
    }}]} : {}),
    createCodexTransport: configuration => {
      assert.equal(typeof configuration.nativeTool, 'function');
      if (configuration.kind === 'remote') assert(configuration.executionAuthority); else assert.equal(typeof configuration.collaboration.authorize, 'function');
      return new CodexEngineAdapter({ ...configuration,
        nativeTool: (...args) => {
          nativeCalls.push({ ...args[0], ...args[1] });
          const result = configuration.nativeTool(...args); if (result === null) { toolFault = 'Browser callback was not claimed by domain dispatcher'; return null; }
          return result.then(value => { if (!value.success) toolFault = value.contentItems.filter(item => item.type === 'inputText'); return value; }, error => {
            toolFault = { code: error.code, message: error.message, outcome: error.outcome }; throw error;
          });
        },
        createMaintenanceClient: async () => { throw Error('No maintenance client used by product acceptance'); },
        spawnAppServer: ({ cwd, env }) => spawn(process.env.OPENCRAFT_CODEX_EXECUTABLE ?? 'codex', ['app-server', '--stdio'], {
          cwd, env: { ...env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
        }),
      });
    },
    startAgentHost: async () => ({ websocketUrl: 'ws://127.0.0.1:9/rpc', async close() {} }),
    createWebServer: async (input: any) => { assembly = input; return createWorkbenchWebServer(input); },
  });
  const originalRequest = assembly.remoteBrowserService.request.bind(assembly.remoteBrowserService);
  const originalReceive = assembly.remoteBrowserService.receive.bind(assembly.remoteBrowserService);
  assembly.remoteBrowserService.receive = message => {
    if (message.type === 'result' && nativeWaitRequests.delete(message.id)) nativeReplyObserved = true;
    return originalReceive(message);
  };
  assembly.remoteBrowserService.request = (...args) => {
    if (revoked && args[1] === 'automation' && args[2]?.method === 'fill') unauthorizedNativeWrites++;
    if (args[1] !== 'automation' || args[2]?.method !== 'wait' || args[2]?.input?.text !== 'product-revocation-never-present') return originalRequest(...args);
    nativeWaits++; assert(args[5]?.signal);
    args[5].signal.addEventListener('abort', () => { waitAborted = true; }, { once: true });
    const before = new Set(assembly.remoteBrowserService.requests.keys());
    const result = originalRequest(...args);
    for (const id of assembly.remoteBrowserService.requests.keys()) if (!before.has(id)) nativeWaitRequests.add(id);
    assert.equal(nativeWaitRequests.size, 1);
    return result.finally(() => { waitSettled = true; });
  };
  const source = `
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createSmokeClientProduct} from '/tests/fixtures/client-product.ts';
import {createWebWorkbenchApplication,WorkbenchRoot} from '/apps/workbench-web/src/workbench-root.tsx';
import {createWorkbenchThreadLocation} from '@opencraft/workbench-runtime';
import {OPENCRAFT_WORKBENCH_DYNAMIC_TOOLS} from '/apps/workbench-web/src/runtime/workbench-dynamic-tools.ts';
import {initializeAppearanceTheme} from '/apps/workbench-web/src/appearance-theme.ts';
import {openWorkbenchUiPreferences,UiPreferencesProvider} from '/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
import {bindInteractionDensity} from '/apps/workbench-web/src/runtime/interaction-density.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
window.productStage='preferences';
const config=document.createElement('script');config.id='opencraft-deployment-config';config.type='application/json';config.textContent=JSON.stringify({hosts:[],builtinAgents:false,hypernode:false});document.head.append(config);
const preferences=await openWorkbenchUiPreferences();
const density=bindInteractionDensity(document,preferences);
window.productStage='application';
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory',deferOptionalFeatures:true,clientProduct:createSmokeClientProduct([],false,true),threadSummary:false,cloudDesktop:null});
window.productStage='mount';
const mount=createIntlTestRoot(document.getElementById('root'));mount.render(<UiPreferencesProvider runtime={preferences}><WorkbenchRoot application={application}/></UiPreferencesProvider>);
if(application.supervisor.mode!=='active')throw Error('Product Host unavailable');
await application.supervisor.initialActivation;
window.productStage='codex-selection';
await application.supervisor.commands.selectHost(${JSON.stringify(hostId)},{model:'browser-fixture',effort:null});
const client=application.supervisor.appServerRegistry.clients.get(${JSON.stringify(hostId)});if(!client)throw Error('Codex client missing');
window.productStage='thread-creation';
const {thread}=await client.request('thread/start',{model:'browser-fixture',approvalPolicy:'never',sandbox:'read-only',dynamicTools:OPENCRAFT_WORKBENCH_DYNAMIC_TOOLS});
await client.request('thread/name/set',{threadId:thread.id,name:'Logged in browser acceptance'});
if(!await application.supervisor.commands.selectConversation(createWorkbenchThreadLocation(${JSON.stringify(hostId)},thread.id)))throw Error('Conversation activation failed');
const completed=[],started=[];const stop=client.subscribeNotification(note=>{if(note.method==='turn/completed')completed.push(note.params.turn);if(note.method==='turn/started')started.push(note.params.turn);});
window.productProof={application,client,threadId:thread.id,completed,started,async dispose(){stop();mount.unmount();await application.dispose();density();await preferences.close();}};
`;
  const productVite = createWorkbenchWebConfig({ command: 'serve', mode: 'development' }, { hyperNode: false, builtinAgents: false });
  vite = await createVite({ configFile: false, root: process.cwd(), publicDir: 'apps/workbench-web/public', logLevel: 'error', cacheDir: 'node_modules/.vite-codex-browser-product',
    resolve: { dedupe: ['react', 'react-dom'] }, esbuild: { jsx: 'automatic' },
    optimizeDeps: { ...productVite.optimizeDeps, include: [...(productVite.optimizeDeps?.include ?? []), 'react', 'react-dom/client', '@opencraft/browser-core/presentation', '@opencraft/browser-core/metadata-sync', '@opencraft/browser-core/automation-policy', '@opencraft/browser-core/metadata-merge',
      '@opencraft/browser-core/metadata-limits', '@opencraft/remote-interaction', '@opencraft/remote-interaction/touch', '@opencraft/remote-interaction/websocket'] },
    define: { 'process.env.NEXT_PUBLIC_REGION': '"cn"', 'process.env.NEXT_PUBLIC_PREVIEW_LOCALES': '""', 'import.meta.env.VITE_INCLUDE_HEADLESS_APPHOST': '"true"', 'import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN': '"false"', 'import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN': '"false"' },
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '^/(?:__opencraft|apphost|ssh-apphost)': { target: origin, ws: true, changeOrigin: true,
      configure(proxy) { proxy.on('proxyReq', request => request.setHeader('origin', origin)); proxy.on('proxyReqWs', request => request.setHeader('origin', origin)); } } } },
    plugins: [{ name: 'codex-browser-product', resolveId: id => id === '/product-proof.tsx' ? id : null, load: id => id === '/product-proof.tsx' ? source : null,
      configureServer(server) { server.middlewares.use((req, res, next) => {
        if (req.url === '/native-demo') { res.setHeader('content-type', 'text/html'); res.end('<label>Name<input></label>'); return; }
        if (req.url !== '/') return next(); res.setHeader('content-type', 'text/html'); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/product-proof.tsx"></script>');
      }); } }],
  });
  await vite.listen(); const ui = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}`; demoUrl = ui + '/native-demo';
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: touch ? { width: 430, height: 932 } : { width: 1440, height: 900 }, hasTouch: touch, isMobile: touch, reducedMotion: 'reduce' });
  const setup = await context.request.post(origin + '/__opencraft_account/setup', { data: { proof, mode: 'web', username: 'operator', password: 'synthetic-product-browser-password' }, headers: { origin } }); assert.equal(setup.status(), 200);
  await context.clearCookies();
  const loginPage = await context.newPage(); await loginPage.goto(origin + '/__opencraft_auth/');
  await loginPage.getByLabel('用户名', { exact: true }).fill('operator');
  await loginPage.getByLabel('密码', { exact: true }).fill('synthetic-product-browser-password');
  const login = loginPage.waitForResponse(response => new URL(response.url()).pathname === '/__opencraft_auth/local' && response.request().method() === 'POST');
  if (touch) await loginPage.getByRole('button', { name: '登录', exact: true }).tap(); else await loginPage.getByRole('button', { name: '登录', exact: true }).click();
  assert.equal((await login).status(), 200); await loginPage.close();
  const identity = await (await context.request.get(origin + '/__opencraft_auth/session')).json(); assert(identity.actor?.id);
  const page = await context.newPage(), errors: string[] = []; let runtimeFault: Error | undefined;
  let rejectBoot!: (error: Error) => void;
  const bootFailure = new Promise<never>((_resolve, reject) => { rejectBoot = reject; }); void bootFailure.catch(() => {});
  page.on('pageerror', error => { runtimeFault ??= error; errors.push(error.message); rejectBoot(error); });
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0, 1000)); });
  page.on('response', response => {
    if (response.status() >= 400 && response.request().resourceType() === 'script') rejectBoot(Error(`Module ${new URL(response.url()).pathname} returned ${response.status()}`));
  });
  const pending = new Map<any, string>();
  page.on('request', request => pending.set(request, new URL(request.url()).pathname));
  page.on('requestfinished', request => pending.delete(request)); page.on('requestfailed', request => pending.delete(request));
  await page.addInitScript('window.__name=value=>value'); const navigation = await page.goto(ui);
  assert((await navigation!.text()).includes('/product-proof.tsx'), 'Vite must serve the product acceptance entry');
  try {
    await Promise.race([page.waitForFunction(() => !!(window as any).productProof, undefined, { timeout: 90000 }), bootFailure]);
    const skip = page.getByRole('button', { name: 'Skip for now', exact: true }); if (await skip.isVisible()) await skip.click();
    else await page.getByRole('button', { name: 'Use an API model instead', exact: true }).click();
    const editor = page.locator('.opencraft-composer-editor[contenteditable="true"]').first(); await editor.waitFor(); await editor.fill('Exercise the admitted foreground browser.');
    const send = page.getByRole('button', { name: 'Send message', exact: true }).first(); if (touch) await send.tap(); else await send.click();
    await Promise.race([page.waitForFunction(() => (window as any).productProof.started.length > 0, undefined, { timeout: 15000 }), inferenceFailure]);
    const turn = { turn: await page.evaluate(() => (window as any).productProof.started[0]) };
    await editor.fill('Unsent logged-in browser draft'); releaseDraft();
    await Promise.race([page.waitForFunction(id => (window as any).productProof.completed.some(turn => turn.id === id && turn.status === 'completed'), turn.turn.id, { timeout: 60000 }), inferenceFailure]);
    if (!touch) await page.getByText('CODEX_BROWSER_PRODUCT_OK', { exact: true }).waitFor();
    if (modelFault) throw modelFault; assert.equal(step, 4); assert(tabId); assert.equal(await editor.textContent(), 'Unsent logged-in browser draft');
    assert.equal(toolFault, undefined, 'all browser callbacks must be accepted by the production domain dispatcher');
    assert.equal(nativeCalls.length, 3); assert.equal(new Set(nativeCalls.map(call => call.callId)).size, 3);
    if (runtimeFault) throw runtimeFault;
    assert(nativeCalls.every(call => call.turnId === turn.turn.id && call.callId));
    assert.deepEqual(nativeCalls.map(call => [call.namespace, call.name]), [['opencraft_app', 'open_in_opencraft'], ['opencraft_browser', 'browser_use'], ['opencraft_browser', 'browser_use']]);
    if (!touch) assert.equal(await editor.evaluate(element => document.activeElement === element), true, 'foreground must preserve composer focus');
    await page.screenshot({ path: join(directory, touch ? 'touch.png' : 'desktop.png') });
    const revokingTurn = await page.evaluate(async () => {
      const p = (window as any).productProof, deadline = Date.now() + 15000;
      for (;;) {
        try { return await p.client.request('turn/start', {
          threadId: p.threadId, clientUserMessageId: 'product-revocation-input', input: [{ type: 'text', text: 'Wait in the same browser until account authority is revoked.' }],
        }); } catch (error) {
          if (error.data?.code !== 'SESSION_TOOLS_RECOVERING' || error.data.submissionOutcome !== 'rejected' || error.data.retryable !== true || Date.now() >= deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    });
    await until(() => nativeWaits === 1, 'Authenticated browser wait never entered the physical provider');
    const inventory = await assembly.remoteBrowserService.request(undefined, 'inventory');
    const nativePage = [...assembly.remoteBrowserService.pages.values()].find(page => page.link?.tabId === tabId);
    assert(inventory.some(page => page.id === nativePage.id), 'Electron must remain responsive while the admitted wait is pending');
    assert.equal(waitSettled, false); assert.equal(waitAborted, false);
    revoked = true; assembly.actorService.store.setEnabled(identity.actor.id, false, identity.actor.id);
    await until(() => waitAborted && waitSettled && nativeReplyObserved, 'Revoking the authenticated human must cancel and receive the original native reply');
    await until(() => deniedPostRevocation, 'A following native model write must be denied before reaching Electron');
    assert.equal(nativeWaits, 1);
    assert.equal(unauthorizedNativeWrites, 0);
    assert.equal((await (await context.request.get(origin + '/__opencraft_auth/session')).json()).actor, null);
    await assert.rejects(page.evaluate(() => { const p = (window as any).productProof; return p.client.request('turn/start', { threadId: p.threadId, input: [{ type: 'text', text: 'Must be denied after account revocation.' }] }); }));
    assert.equal(step, 7); assert.equal(nativeCalls.length, 5);
    assert.equal(nativeCalls[3].turnId, revokingTurn.turn.id);
    assert.equal(nativeCalls[4].turnId, revokingTurn.turn.id);
    if (runtimeFault) throw runtimeFault;
    if (remote) assert.equal(proxyConnections, 1, 'One production SSH transport must retain the actual native proxy');
    await writeFile(join(directory, 'evidence.json'), JSON.stringify({ touch, hostId, sshExecFixture:remote&&!networkSsh, realNetworkSsh:networkSsh, sshPublicKeyAuthentication:networkSsh, unknownHostKeyRejected:networkSsh, realNativeProxy:remote, proxyConnections, realLogin: true, actualLoginForm: true, actualComposerSubmission: true, realHeadlessComposition: true, realCodex: true, realElectron: true,
      nativeTurn: turn.turn.id, revokingTurn: revokingTurn.turn.id, nativeCalls, tabId, modelRequests: step, foregroundPaintAcknowledged: true, draftPreserved: true, typedImageReturned: true, humanRevocationDenied: true, revokedSessionActorAbsent: true,
      revocationDuringNativeWait: true, nativeWaits, nativeAbortObserved: waitAborted, physicalReplySettled: waitSettled, originalNativeReplyObserved: nativeReplyObserved,
      postRevocationModelWriteDenied: deniedPostRevocation, unauthorizedNativeWrites,
      boundary: 'synthetic inference/native startup config and unused second engine; ssh-proxy substitutes OpenSSH exec; ssh-network uses real loopback OpenSSH with private fixture host/user keys (not external-machine placement); production authority/domain hooks retained; client product/intl wrappers are presentation fixtures' }, null, 2));
    console.log('CODEX_BROWSER_FULL_PRODUCT_OK', directory);
  } catch (error) { console.error('PRODUCT_ACCEPTANCE_CONTEXT', JSON.stringify({ stage: await page.evaluate(() => (window as any).productStage), modelStep: step, toolFault, pending: [...pending.values()], errors, modelFault: String(modelFault ?? ''), html: (await page.content()).slice(-1500), body: (await page.locator('body').innerText()).slice(-4000) })); await page.screenshot({ path: join(directory, 'failure.png') }); throw error; }
  finally { await page.evaluate(() => (window as any).productProof?.dispose()).catch(() => {}); await context.close(); }
} finally {
  releaseDraft();
  await browser?.close(); await vite?.close(); await app?.close(); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
  if (nativeServer && nativeServer.exitCode === null && nativeServer.signalCode === null) { const closed = once(nativeServer,'close'); nativeServer.kill('SIGTERM'); await closed; }
  await sshFixture?.close();
}
