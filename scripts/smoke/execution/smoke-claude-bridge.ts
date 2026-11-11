/**
 * Real-account smoke for the opt-in Claude Agent SDK bridge (P2c).
 *
 * It uses one temporary directory, one cheapest-available model, one
 * non-destructive Read tool call and one steer. It never edits files outside
 * the temporary directory and never uses bypassPermissions. Run manually:
 *
 *   npm run build --workspace @opencraft/claude-code-bridge
 *   node --import tsx scripts/smoke/execution/smoke-claude-bridge.ts
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SandboxBackend } from '@opencraft/sandbox';
import { BridgeHost, type Generation } from '../../../apps/agent-bridge-host/src/index.js';
import { CLAUDE_BRIDGE_DECLARATION } from '../../../apps/claude-code-bridge/src/declaration.js';

const artifact = resolve('apps/claude-code-bridge/dist/claude-code-bridge.mjs');
const executable = process.env.CLAUDE_CODE_EXECUTABLE;
const timeoutMs = Number(process.env.CLAUDE_SMOKE_TIMEOUT_MS ?? 180_000);
const token = 'smoke-private-token-000000000000000000000';

interface Frame { id?: string; method?: string; params?: any; result?: any; error?: any }

function parseLines(onLine: (frame: Frame) => void): (chunk: Buffer) => void {
  let carry = '';
  return (chunk) => {
    carry += chunk.toString('utf8');
    for (;;) {
      const index = carry.indexOf('\n');
      if (index < 0) return;
      const line = carry.slice(0, index);
      carry = carry.slice(index + 1);
      if (line.trim().length > 0) onLine(JSON.parse(line) as Frame);
    }
  };
}

async function probeModels(root: string): Promise<{ models: any[]; nativeVersion: string; stderr: string }> {
  const child = spawn(process.execPath, [artifact], {
    cwd: root,
    env: { ...process.env, ...(executable ? { CLAUDE_CODE_EXECUTABLE: executable } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  child.stderr.on('data', (data) => { stderr += String(data); });
  const frames: Frame[] = [];
  let waiter: (() => void) | undefined;
  child.stdout.on('data', parseLines((frame) => {
    frames.push(frame);
    if (frame.method && frame.id) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { durable: true } }) + '\n');
    }
    waiter?.();
  }));
  const waitFor = async (id: string): Promise<Frame> => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const frame = frames.find((entry) => entry.id === id);
      if (frame) return frame;
      await new Promise<void>((resolve) => { waiter = resolve; setTimeout(resolve, 50); });
    }
    throw new Error(`Model probe did not answer ${id}. stderr: ${stderr.slice(-2000)}`);
  };
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: 1, grammarRange: { min: 1, max: 1 } } }) + '\n');
  await waitFor('init');
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 'models',
    method: 'model/list',
    params: { cwd: root },
  }) + '\n');
  const reply = await waitFor('models').catch(async (error) => {
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((accept) => setTimeout(accept, 2_000))]);
    throw error;
  });
  child.stdin.end();
  await Promise.race([exited, new Promise((accept) => setTimeout(accept, 5_000))]);
  if (child.exitCode === null) child.kill('SIGTERM');
  if (reply.error) throw new Error(`model/list failed: ${JSON.stringify(reply.error)}. stderr: ${stderr.slice(-2000)}`);
  return { models: reply.result.models ?? [], nativeVersion: reply.result.nativeVersion ?? 'unknown', stderr };
}

function cheapest(models: any[]): any {
  const rank = (model: any): number => {
    const haystack = `${model.id ?? ''} ${model.name ?? ''} ${model.resolvedModel ?? ''}`.toLowerCase();
    if (haystack.includes('haiku')) return 0;
    if (haystack.includes('sonnet')) return 1;
    if (haystack.includes('fable')) return 2;
    if (haystack.includes('opus')) return 3;
    if (haystack.includes('default')) return 4;
    return 5;
  };
  return [...models].sort((left, right) => rank(left) - rank(right) || String(left.id).localeCompare(String(right.id)))[0];
}

function processBackend(stderrPath: string): SandboxBackend {
  return {
    id: 'smoke-process-group',
    async initialize() {},
    async close() {},
    async create(_identity, resources) {
      const groups: number[] = [];
      return {
        resources,
        capabilities: { terminal: false },
        async spawn(command, output) {
          const child = spawn(command.command[0]!, command.command.slice(1), {
            cwd: command.cwd,
            env: { ...command.env },
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
          groups.push(child.pid!);
          child.stdout.on('data', (data) => output?.({ stream: 'stdout', data }));
          child.stderr.on('data', (data) => { void writeFile(stderrPath, String(data), { flag: 'a' }); });
          const exited = new Promise<{ code: number | null }>((resolveExit) => child.once('exit', (code) => resolveExit({ code })));
          return {
            id: String(child.pid),
            kind: 'process',
            exited,
            async terminate() { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} await exited; },
            writeStdin: (data) => new Promise<void>((resolveWrite, rejectWrite) => child.stdin.write(data, (error) => error ? rejectWrite(error) : resolveWrite())),
            closeStdin: async () => { child.stdin.end(); },
          };
        },
        async close() {
          for (const pid of groups) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
        },
      };
    },
  };
}

async function waitForReceipt(host: BridgeHost, id: string, deadline = Date.now() + 60_000) {
  while (Date.now() < deadline) {
    const receipt = await host.query(id);
    if (receipt && receipt.state !== 'registered' && receipt.state !== 'dispatching') return receipt;
    await new Promise((accept) => setTimeout(accept, 50));
  }
  throw new Error(`Command ${id} did not settle`);
}

async function collectEvents(host: BridgeHost): Promise<any[]> {
  const all: any[] = [];
  let cursor = 0;
  for (;;) {
    const page = await host.events(cursor, 256);
    if (!page.length) return all;
    all.push(...page);
    cursor = page.at(-1).seq;
  }
}

async function main(): Promise<void> {
  if (!executable) throw new Error('CLAUDE_CODE_EXECUTABLE must point at the pinned Claude Code CLI');
  if (!existsSync(artifact)) throw new Error(`Missing ${artifact}; run npm run build --workspace @opencraft/claude-code-bridge`);
  const root = await mkdtemp(join(tmpdir(), 'opencraft-claude-bridge-smoke-'));
  const stderrPath = join(root, 'bridge.stderr');
  await writeFile(join(root, 'note.txt'), 'The launch code is ORANGE-42. The weather today is calm.\n');
  const host = await BridgeHost.open({
    path: join(root, 'host.db'),
    policy: { id: 'claude-smoke', capacity: { cpuMillis: 8000, memoryBytes: 16 * 1024 ** 3 } },
    backend: processBackend(stderrPath),
  });
  try {
    const probe = await probeModels(root);
    const model = cheapest(probe.models);
    if (!model) throw new Error('No Claude model was available');
    console.log(JSON.stringify({ phase: 'model', available: probe.models.map((entry: any) => entry.id), chosen: model.id, nativeVersion: probe.nativeVersion, executable }));

    const digest = createHash('sha256').update(await readFile(artifact)).digest('hex');
    const config: Generation = {
      id: 'claude-smoke-generation',
      artifact,
      digest,
      provider: CLAUDE_BRIDGE_DECLARATION,
      launch: {
        command: [process.execPath, artifact],
        cwd: root,
        env: {
          ...process.env,
          ...(executable ? { CLAUDE_CODE_EXECUTABLE: executable } : {}),
          CLAUDE_BRIDGE_DEBUG: '1',
        } as Record<string, string>,
      },
    };
    await host.add(config);
    await host.activate(config.id, '');
    await host.accept({
      commandId: 'create',
      serverId: 'smoke-server',
      threadId: 'smoke-thread',
      method: 'session/create',
      params: { cwd: root, model: model.id, permissionMode: 'default', allowedTools: ['Read'] },
    });
    const created = await waitForReceipt(host, 'create');
    if (created.state !== 'accepted') throw new Error(`session/create ${created.state}: ${JSON.stringify(created.response)}`);

    const prompt = [
      'Use the Read tool to read note.txt in the current working directory.',
      'Then write a detailed 250-word explanation of the note, quoting its exact text.',
      'Keep writing until the explanation is complete.',
    ].join(' ');
    await host.accept({
      commandId: 'start',
      serverId: 'smoke-server',
      threadId: 'smoke-thread',
      method: 'turn/start',
      params: { inputId: 'smoke-initial', clientRequestId: 'smoke-initial-client', text: prompt },
    });
    const started = await waitForReceipt(host, 'start');
    if (started.state !== 'accepted') throw new Error(`turn/start ${started.state}: ${JSON.stringify(started.response)}`);

    await host.accept({
      commandId: 'steer',
      serverId: 'smoke-server',
      threadId: 'smoke-thread',
      method: 'turn/steer',
      params: {
        inputId: 'smoke-steer',
        clientRequestId: 'smoke-steer-client',
        text: 'Important addition: include the exact word PINEAPPLE in your final answer, and mention the note color.',
      },
    });
    const steered = await waitForReceipt(host, 'steer');
    if (steered.state !== 'accepted') throw new Error(`turn/steer ${steered.state}: ${JSON.stringify(steered.response)}`);

    const deadline = Date.now() + timeoutMs;
    let events: any[] = [];
    while (Date.now() < deadline) {
      events = await collectEvents(host);
      if (events.some((row) => row.payload?.kind === 'canonical' && row.payload.event?.kind === 'turn.completed')) break;
      await new Promise((accept) => setTimeout(accept, 250));
    }
    const canonical = events
      .map((row) => row.payload)
      .filter((payload) => payload?.kind === 'canonical')
      .map((payload) => payload.event);
    const completed = canonical.find((event) => event.kind === 'turn.completed');
    if (!completed) {
      const stderr = await readFile(stderrPath, 'utf8').catch(() => '');
      throw new Error(`Turn did not complete within ${timeoutMs}ms. bridge stderr: ${stderr.slice(-4000)}`);
    }
    const toolItems = canonical
      .filter((event) => event.kind === 'item.completed' && event.item?.shape?.kind === 'tool')
      .map((event) => event.item.shape.name);
    const agentMessages = canonical
      .filter((event) => event.kind === 'item.completed' && event.item?.shape?.kind === 'agentMessage')
      .map((event) => event.item.shape.text);
    const finalText = agentMessages.at(-1) ?? '';
    const steerStates = canonical.filter((event) => event.kind === 'input.state' && event.status.inputId === 'smoke-steer');
    const steer = steerStates.at(-1)?.status;
    const initialStates = canonical.filter((event) => event.kind === 'input.state' && event.status.inputId === 'smoke-initial');
    const initial = initialStates.at(-1)?.status;
    const evidenceGrade = steer?.evidence?.value === 'context-confirmed' ? 'context-confirmed'
      : steer?.outcome === 'unknown' ? 'unknown'
      : 'admission-only';
    const summary = {
      phase: 'turn',
      model: model.id,
      nativeVersion: probe.nativeVersion,
      turnStatus: completed.status,
      turnCount: canonical.filter((event) => event.kind === 'turn.started').length,
      toolItems,
      steerEvidence: steer?.evidence ?? null,
      steerOutcome: steer?.outcome ?? null,
      evidenceGrade,
      initialEvidence: initial?.evidence?.value ?? null,
      pineappleInFinalAnswer: /PINEAPPLE/iu.test(finalText),
      finalTextExcerpt: finalText.slice(0, 400),
      bridgePid: (created.response as any)?.result?.pid ?? null,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (completed.status !== 'completed') throw new Error(`Turn completed as ${completed.status}`);
    if (summary.turnCount !== 1) throw new Error(`Expected one canonical turn, saw ${summary.turnCount}`);
    if (!toolItems.some((name) => name === 'Read')) throw new Error(`Read tool did not complete; saw ${JSON.stringify(toolItems)}`);
    if (initial?.evidence?.value !== 'context-confirmed') throw new Error(`Initial evidence is ${initial?.evidence?.value}, expected context-confirmed`);
    if (evidenceGrade !== 'context-confirmed') throw new Error(`Steer evidence grade is ${evidenceGrade}, expected context-confirmed for Claude ${probe.nativeVersion}`);
    if (typeof steer?.evidence?.evidenceRef !== 'string') throw new Error('Steer has no native evidenceRef');
    if (!summary.pineappleInFinalAnswer) throw new Error('Final answer does not contain the steer marker PINEAPPLE');
    await host.accept({ commandId: 'close', serverId: 'smoke-server', threadId: 'smoke-thread', method: 'session/close', params: {} });
    await waitForReceipt(host, 'close');
    const high = (await collectEvents(host)).at(-1)?.seq;
    if (typeof high === 'number') await host.ack(high);
    await host.releaseThread('smoke-server', 'smoke-thread');
  } finally {
    await host.close().catch(() => {});
    const stderr = await readFile(stderrPath, 'utf8').catch(() => '');
    if (stderr.trim()) console.log(JSON.stringify({ phase: 'bridge-stderr', tail: stderr.slice(-2000) }));
    await rm(root, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  },
);
