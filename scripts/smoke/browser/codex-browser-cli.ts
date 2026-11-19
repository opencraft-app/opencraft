import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';

/** Real CLI/MCP/native browser; only model decisions and execution authority are
 * fixtures. The local Responses endpoint validates the previous native result
 * before emitting the next tool call. No real login/profile is copied. */
export async function runCodexBrowserCli(directory: string, configuration: Record<string, unknown>, url: string) {
  const executable = process.env.OPENCRAFT_CODEX_EXECUTABLE ?? 'codex';
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();
  const home = join(directory, 'codex-cli'), task = join(home, 'task');
  await mkdir(task, { recursive: true });
  let tabId = '', inspection: any, step = 0, fault: Error | undefined;
  const calls: string[] = [], events: any[] = [];
  function texts(value: any): string[] {
    if (typeof value === 'string') {
      try { return [value, ...texts(JSON.parse(value))]; } catch { return [value]; }
    }
    return value && typeof value === 'object' ? Object.values(value).flatMap(texts) : [];
  }
  function output(body: any, id: number) {
    const value = body.input.findLast((item: any) => item.type === 'function_call_output' && item.call_id === 'browser-cli-' + id);
    assert(value, 'CLI must submit the tool result to its next model request');
    return value.output;
  }
  function object(value: any, predicate: (value: any) => boolean): any {
    for (const text of texts(value)) {
      try { const parsed = JSON.parse(text); if (predicate(parsed)) return parsed; } catch { /* another text block */ }
    }
    assert.fail('Expected structured browser result missing: ' + JSON.stringify(value).slice(0, 600));
  }
  function completed(value: any) {
    return object(value, result => result?.completed === true || result?.accepted === true || result?.closed === true);
  }
  const use = (action: string, args: Record<string, unknown> = {}) => ({ name: 'opencraft_browser_browser_use', arguments: { action, tab_id: tabId, ...args } });
  const stages = [
    (_body: any) => ({ name: 'opencraft_app_open_in_opencraft', arguments: { url, visible: false } }),
    (body: any) => { tabId = object(output(body, 0), v => typeof v?.tabId === 'string').tabId; return use('list_tabs'); },
    (body: any) => { assert(object(output(body, 1), v => Array.isArray(v?.tabs)).tabs.some((v: any) => v.tabId === tabId)); return use('inspect'); },
    (body: any) => { inspection = object(output(body, 2), v => Array.isArray(v?.elements)); return use('fill', { ref: inspection.elements.find((e: any) => e.name === 'Password').ref, expected_revision: inspection.revision, value: 'blocked' }); },
    (body: any) => { assert(texts(output(body, 3)).some(t => t.includes('POLICY_BLOCKED'))); return use('fill', { ref: inspection.elements.find((e: any) => e.name === 'Name').ref, expected_revision: inspection.revision, value: 'CodexCLI' }); },
    (body: any) => { completed(output(body, 4)); return use('click', { ref: inspection.elements.find((e: any) => e.name === 'Submit').ref, expected_revision: inspection.revision }); },
    (body: any) => { completed(output(body, 5)); return use('wait', { text: 'Hello CodexCLI', timeout_ms: 5000 }); },
    (body: any) => { completed(output(body, 6)); return { name: 'opencraft_browser_get_tab_context', arguments: { tab_id: tabId } }; },
    (body: any) => { const result = JSON.stringify(output(body, 7)); assert(result.includes('Hello CodexCLI')); assert(!result.includes('never-export-this')); return use('screenshot'); },
    (body: any) => {
      const result = output(body, 8);
      const image = Array.isArray(result) ? result.find(item => item.type === 'input_image')?.image_url : undefined;
      assert.equal(typeof image, 'string', 'Screenshot must remain an input_image, not text containing an image URL');
      assert(image, 'CLI must return MCP screenshot as typed image input to its model');
      const png = Buffer.from(image.split(',')[1]!, 'base64'); assert.equal(png.subarray(1, 4).toString(), 'PNG');
      assert(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0);
      return use('navigate', { url: new URL('/cli-navigation.html', url).href });
    },
    (body: any) => { completed(output(body, 9)); return use('wait', { text: 'Codex CLI navigation destination', timeout_ms: 5000 }); },
    (body: any) => { completed(output(body, 10)); return use('close'); },
    (body: any) => { assert.equal(completed(output(body, 11)).closed, true); return use('close'); },
    (body: any) => { assert.equal(completed(output(body, 12)).closed, true); return use('list_tabs'); },
    (body: any) => { assert(!object(output(body, 13), v => Array.isArray(v?.tabs)).tabs.some((v: any) => v.tabId === tabId)); return use('inspect', { tab_id: 'foreign-cli-tab' }); },
    (body: any) => { assert(texts(output(body, 14)).some(t => t.includes('TAB_ACCESS_DENIED'))); return null; },
  ];
  const model = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks), encoding = request.headers['content-encoding'];
      const body = JSON.parse((encoding === 'zstd' ? zstdDecompressSync(bytes) : encoding === 'gzip' ? gunzipSync(bytes) : bytes).toString());
      assert(request.url?.endsWith('/responses'), 'Only isolated Responses inference is allowed');
      assert(step < stages.length, 'CLI must finish after the bounded sequence');
      const next = stages[step]!(body), id = 'cli-response-' + step;
      const item = next ? { type: 'function_call', id: 'item-' + step, call_id: 'browser-cli-' + step,
        namespace: 'mcp__browser', name: next.name, arguments: JSON.stringify(next.arguments), status: 'completed' }
        : { type: 'message', id: 'cli-final', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'CODEX_BROWSER_CLI_OK', annotations: [] }] };
      if (next) calls.push(next.name + (next.arguments && 'action' in next.arguments ? ':' + next.arguments.action : ''));
      step++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]) response.write('data: ' + JSON.stringify(event) + '\n\n');
      response.end();
    } catch (error) { fault ??= error as Error; response.writeHead(500); response.end('Local CLI verification rejected the sequence'); }
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const port = (model.address() as { port: number }).port;
  const configPath = join(home, 'config.toml');
  // TOML inline tables are generated structurally, never via shell interpolation.
  const toml = (value: any): string => value && typeof value === 'object'
    ? '{' + Object.entries(value).map(([k, v]) => JSON.stringify(k) + '=' + toml(v)).join(',') + '}' : JSON.stringify(value);
  await writeFile(configPath, [
    'model="browser-fixture"', 'model_provider="browser_fixture"', 'approval_policy="never"',
    'sandbox_mode="read-only"', 'web_search="disabled"',
    '[model_providers.browser_fixture]', 'name="Browser CLI local fixture"', `base_url="http://127.0.0.1:${port}/v1"`,
    'wire_api="responses"', 'requires_openai_auth=false', 'supports_websockets=false', 'request_max_retries=0', 'stream_max_retries=0',
    '[mcp_servers.browser]', ...Object.entries({ ...configuration,
      // Explicit consent for this isolated acceptance sequence. Production
      // browser declarations retain their ordinary human approval policy.
      tools: Object.fromEntries(['opencraft_app_open_in_opencraft', 'opencraft_browser_browser_use', 'opencraft_browser_get_tab_context']
        .map(name => [name, { approval_mode: 'approve' }])),
    }).map(([k, v]) => JSON.stringify(k) + '=' + toml(v)),
    'required=true',
  ].join('\n'), { mode: 0o600 });
  const child = spawn(executable, ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-C', task,
    'Verify this isolated browser fixture through the supplied browser MCP tools.'], {
    env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    if (fault) throw fault;
    assert.equal(code, 0, 'Codex CLI failed: ' + stderr.slice(-2000) + '\n' + stdout.slice(-2500));
    for (const line of stdout.trim().split('\n')) events.push(JSON.parse(line));
    assert.equal(step, stages.length);
    assert(events.some(e => e.type === 'turn.completed'));
    const toolEvents = events.filter(e => e.type === 'item.completed' && e.item?.type === 'mcp_tool_call');
    assert.equal(toolEvents.length, calls.length);
    assert(events.some(e => e.type === 'item.completed' && e.item?.text === 'CODEX_BROWSER_CLI_OK'));
    const evidence = { cli: version, model: 'synthetic loopback Responses only', executionAuthority: 'fixture',
      nativeBrowser: 'packaged Electron/private Owner/CDP', cliThread: events.find(e => e.type === 'thread.started')?.thread_id,
      calls, modelRequests: step, completedToolEvents: toolEvents.length,
      checks: ['background-create', 'owned-tab-list', 'inspect-refs', 'sensitive-fill-denied', 'native-fill-click-wait',
        'context-redacted', 'typed-PNG-returned-to-model', 'navigation-destination-marker', 'close', 'close-receipt-replay', 'closed-tab-absent', 'unknown-tab-denied'] };
    await writeFile(join(directory, 'codex-browser-cli-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log('CODEX_BROWSER_CLI_OK: ' + JSON.stringify(evidence));
    return { tabId, evidence };
  } finally {
    clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL');
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(configPath, { force: true });
  }
}
