/** Opt-in DSH acceptance through Host. Uses an explicitly prepared DSH_HOME,
 * one harmless sleep tool and one native steer; never retries mutations.
 * The test backend checks Host routing, not kernel isolation.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BridgeHost, type Generation } from "../../../apps/agent-bridge-host/src/index.js";
import { declarationFor, profileFromEnv } from "../../../packages/agent-bridge-acp/src/index.js";
import { localTestBackend } from "../../../tests/agent-bridge/fixtures/local-backend.js";

const out = resolve(process.argv[2] ?? 'design/agent-bridge/recordings/p3b/dsh-host.json');
const agent = 'dsh';
const artifact = resolve('packages/agent-bridge-acp/src/main.ts');
const root = await mkdtemp(join(tmpdir(), 'p3b-task-'));
const hostRoot = await mkdtemp(join(tmpdir(), 'p3b-host-'));
const tracePath = join(hostRoot, 'wire.ndjson');
const serverId = 'p3b-real', threadId = 'p3b-dsh';
const profileEnv = {
 PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
 DSH_HOME: process.env.DSH_HOME ?? '/tmp/p3b-dsh-home',
 AGENT_BRIDGE_ACP_PROVIDER: 'dsh', AGENT_BRIDGE_ACP_DIALECT: 'dsh',
 AGENT_BRIDGE_ACP_COMMAND: 'dsh', AGENT_BRIDGE_ACP_ARGS: '["acp"]',
 AGENT_BRIDGE_ACP_CWD: root, AGENT_BRIDGE_ACP_PERMISSION_MODE: 'full',
 AGENT_BRIDGE_ACP_TRACE: tracePath,
};
const profile = profileFromEnv(profileEnv);
const config: Generation = {
  id: `p3b-${agent}`,
  artifact,
  digest: createHash("sha256").update(await readFile(artifact)).digest("hex"),
  provider: declarationFor(profile),
  launch: {
    command: [process.execPath, "--import", "tsx", artifact],
    cwd: resolve("."),
    env: profileEnv,
  },
};
const host = await BridgeHost.open({
  path: join(hostRoot, "host.db"),
  policy: { id: `p3b-${agent}`, capacity: { cpuMillis: 16_000, memoryBytes: 32 * 1024 ** 3 } },
  backend: localTestBackend(),
});

function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function command(commandId: string, method: string, params: Record<string, unknown> = {}) {
  return { commandId, serverId, threadId, method, params };
}
function redact(value: unknown): unknown {
  const text = JSON.stringify(value);
  return JSON.parse(text
    .split(root).join("<workspace>")
    .split(hostRoot).join("<host>")
    .split(process.env.HOME ?? "/home/user").join("<home>"));
}

const collected: any[] = [];
let cursor = 0;
let nativeSessionId: string | null = null;
let interactionCount = 0;

async function settle(commandId: string, timeoutMs = 120_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await host.query(commandId);
    if (receipt !== null && ["accepted", "rejected", "unknown", "failed", "not-sent"].includes(receipt.state)) {
      return receipt;
    }
    if (Date.now() > deadline) throw new Error(`command ${commandId} did not settle`);
    await wait(50);
  }
}

async function pump(): Promise<void> {
  const events = await host.events(cursor, 256);
  for (const event of events) {
    cursor = event.seq;
    const payload = event.payload;
    if (payload.kind === "canonical") {
      collected.push(payload.event);
      continue;
    }
    if (payload.method === "thread/identity" && typeof payload.params.providerThreadId === "string") {
      nativeSessionId = payload.params.providerThreadId;
    }
    if (payload.method === "interaction/request") {
      interactionCount += 1;
      const params = payload.params;
      const result = params.kind === "approval"
        ? { decision: "accept" }
        : { decision: "accept", content: {} };
      const commandId = `resolve-${params.interactionId}`;
      await host.accept(command(commandId, "interaction/resolve", { interactionId: params.interactionId, result }));
      const receipt = await settle(commandId);
      if (receipt.state !== "accepted") throw new Error(`interaction resolve ${receipt.state}`);
    }
  }
  if (events.length > 0) await host.ack(cursor);
}

async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error(`${label} timed out`);
    await wait(100);
  }
}

async function send(commandId: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  await host.accept(command(commandId, method, params));
  return settle(commandId);
}

function turns(): any[] { return collected.filter((event) => event.kind === "turn.completed"); }
function messages(): any[] {
  return collected.filter((event) => event.kind === "item.completed" && event.item?.shape?.kind === "agentMessage");
}
function lastText(): string { return messages().at(-1)?.item?.shape?.text ?? ""; }

try {
 await host.add(config); await host.activate(config.id, '');
 const create = await send('create', 'session/create', { cwd: root, permissionMode: 'full' });
 if (create.state !== 'accepted') throw new Error(JSON.stringify(create.response));
 const models = await send('models', 'model/list');
 const task = await send('task', 'turn/start', { input: { text: 'Run exactly one shell command: sleep 8. Then reply DONE. Do not do anything else.' } });
 await until(async () => { await pump(); return collected.some(e => e.kind === 'item.started' && ['tool', 'command'].includes(e.item?.shape?.kind)); }, Boolean, 'tool start');
 const steer = await send('steer', 'turn/steer', { inputId: 'p3b-steer', clientRequestId: 'p3b-steer-client', expectedTurnId: task.response?.result?.nativeTurnId, delivery: 'native-inject', input: { text: 'After the tool completes reply STEERED instead of DONE.' } });
 if (steer.state !== 'accepted') throw new Error(JSON.stringify(steer.response));
 await until(async () => { await pump(); return turns().length; }, n => n > 0, 'turn completion');
 const query = await send('query', 'input/query', { inputIds: ['p3b-steer'] });
 const wire = await readFile(tracePath, 'utf8');
 const privateFrames = wire.split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(f => JSON.stringify(f).includes('"private":true'));
 const recording = redact({ agent, models, steer, query, privateFrames, collected });
 await writeFile(out, JSON.stringify(recording, null, 2) + '\n');
 console.log(JSON.stringify({ out, query: query.response, privateFrames }, null, 2));
 await send('close', 'session/close'); await host.releaseThread(serverId, threadId);
} finally { await host.close(); await rm(root, {recursive:true,force:true}); await rm(hostRoot,{recursive:true,force:true}); }
