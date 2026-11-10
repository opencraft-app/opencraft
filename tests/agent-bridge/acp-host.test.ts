import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BridgeHost, type Generation } from "../../apps/agent-bridge-host/src/index.js";
import { declarationFor, profileFromEnv } from "../../packages/agent-bridge-acp/src/index.js";
import { localTestBackend } from "./fixtures/local-backend.js";

const fixture = resolve("tests/agent-bridge/fixtures/acp-agent.mjs");
const artifact = resolve("packages/agent-bridge-acp/src/main.ts");
const policy = { id: "test-acp-bridge", capacity: { cpuMillis: 16_000, memoryBytes: 32 * 1024 ** 3 } };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label = "condition"): Promise<T> {
  for (let index = 0; index < 400; index += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(25);
  }
  throw new Error(`${label} timed out`);
}

async function config(root: string, fixtureEnv: Record<string, string> = {}): Promise<Generation> {
  const env = {
    ...process.env,
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? root,
    AGENT_BRIDGE_ACP_PROVIDER: "fixture",
    AGENT_BRIDGE_ACP_DIALECT: "generic",
    AGENT_BRIDGE_ACP_COMMAND: process.execPath,
    AGENT_BRIDGE_ACP_ARGS: JSON.stringify([fixture]),
    AGENT_BRIDGE_ACP_CWD: root,
    AGENT_BRIDGE_ACP_PERMISSION_MODE: "auto",
    ACP_FIXTURE_NATIVE_STEER: "1",
    ACP_FIXTURE_PERMISSION: "1",
    ACP_FIXTURE_DELAY_MS: "40",
    ...fixtureEnv,
  } as Record<string, string>;
  return {
    id: "acp-g1",
    artifact,
    digest: createHash("sha256").update(await readFile(artifact)).digest("hex"),
    provider: declarationFor(profileFromEnv(env)),
    launch: {
      command: [process.execPath, "--import", "tsx", artifact],
      cwd: resolve("."),
      env,
    },
  };
}

function command(commandId: string, method: string, params: Record<string, unknown> = {}) {
  return { commandId, serverId: "server-1", threadId: "thread-1", method, params };
}

function canonical(events: any[]): any[] {
  return events.filter((event) => event.payload.kind === "canonical").map((event) => event.payload.event);
}

test("P1b Host runs the generic ACP bridge: projection, approval channel and native steer evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-host-"));
  const host = await BridgeHost.open({ path: join(root, "host.db"), policy, backend: localTestBackend() });
  t.after(async () => { await host.close().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  await host.add(await config(root));
  await host.activate("acp-g1", "");

  await host.accept(command("create", "session/create", { cwd: root, permissionMode: "auto" }));
  await until(() => host.query("create"), (receipt) => receipt?.state === "accepted", "session create");

  await host.accept(command("start", "turn/start", { input: { text: "inspect the fixture" } }));
  await until(() => host.query("start"), (receipt) => receipt?.state === "accepted", "turn start");

  const interaction = await until(() => host.events(0), (events) =>
    events.some((event: any) => event.payload.method === "interaction/request"), "approval interaction");
  const interactionEvent = interaction.find((event: any) => event.payload.method === "interaction/request")!;
  assert.equal(interactionEvent.payload.params.kind, "approval");
  assert.equal(interactionEvent.payload.params.payload.params.availableDecisions.length, 2);
  await host.accept(command("resolve", "interaction/resolve", {
    interactionId: interactionEvent.payload.params.interactionId,
    result: { decision: "accept" },
  }));
  await until(() => host.query("resolve"), (receipt) => receipt?.state === "accepted", "interaction resolve");
  await until(() => host.events(0), (events) =>
    canonical(events).some((event: any) => event.kind === "turn.completed"), "first turn completion");

  const first = canonical(await host.events(0));
  assert(first.some((event) => event.kind === "turn.started"));
  assert(first.some((event) => event.kind === "item.completed" && event.item.shape?.kind === "agentMessage"
    && /fixture answer/u.test(event.item.shape.text)));
  assert(first.some((event) => event.kind === "item.completed" && event.item.shape?.kind === "command"));
  assert.equal(first.filter((event) => event.kind === "turn.completed").length, 1);

  // Full mode avoids a second human approval and keeps the turn open long
  // enough for the native steer path.
  await host.accept(command("start-2", "turn/start", {
    permissionMode: "full",
    input: { text: "say one two three four five six seven eight nine ten" },
  }));
  const second = await until(() => host.query("start-2"), (receipt) => receipt?.state === "accepted", "second turn");
  const nativeTurnId = (second?.response as any)?.result?.nativeTurnId;
  assert.match(nativeTurnId, /^acp:/u);
  await delay(150);
  await host.accept(command("steer", "turn/steer", {
    inputId: "steer-1",
    clientRequestId: "client-steer-1",
    expectedTurnId: nativeTurnId,
    delivery: "native-inject",
    input: { text: "use the blue door" },
  }));
  await until(() => host.query("steer"), (receipt) => receipt?.state === "accepted", "native steer");
  const steered = await until(() => host.events(0), (events) => {
    const states = canonical(events).filter((event: any) =>
      event.kind === "input.state" && event.status.inputId === "steer-1");
    return states.some((event: any) => event.status.admission.value === "accepted"
      && event.status.delivery.value === "native-inject"
      && event.status.evidence.value === "evidence-observed");
  }, "native steer evidence");
  const states = canonical(steered).filter((event: any) =>
    event.kind === "input.state" && event.status.inputId === "steer-1");
  const latest = states.at(-1);
  assert.equal(latest?.status.delivery.value, "native-inject");
  assert.equal(latest?.status.evidence.value, "evidence-observed");
  assert.equal(states.some((event: any) => event.status.disposition === "queued"), false);

  await until(() => host.events(0), (events) =>
    canonical(events).filter((event: any) => event.kind === "turn.completed").length >= 2, "second turn completion");
  const all = canonical(await host.events(0));
  assert.equal(all.filter((event: any) => event.kind === "turn.started").length, 2);
  assert.equal(all.filter((event: any) => event.kind === "turn.completed").length, 2);
});


test("a next-turn input settles its Host route and can be released", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-host-next-"));
  const host = await BridgeHost.open({ path: join(root, "host.db"), policy, backend: localTestBackend() });
  t.after(async () => { await host.close().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  await host.add(await config(root, {
    ACP_FIXTURE_NATIVE_STEER: "0",
    ACP_FIXTURE_PERMISSION: "0",
    ACP_FIXTURE_DELAY_MS: "30",
  }));
  await host.activate("acp-g1", "");

  await host.accept(command("create", "session/create", { cwd: root, permissionMode: "auto" }));
  await until(() => host.query("create"), (receipt) => receipt?.state === "accepted", "session create");
  await host.accept(command("start", "turn/start", { input: { text: "first task" } }));
  await until(() => host.query("start"), (receipt) => receipt?.state === "accepted", "first turn");
  await until(() => host.events(0), (events) =>
    canonical(events).filter((event: any) => event.kind === "turn.completed").length >= 1, "first turn completion");

  await host.accept(command("start-2", "turn/start", { input: { text: "one two three four five six seven eight" } }));
  await until(() => host.query("start-2"), (receipt) => receipt?.state === "accepted", "second turn");
  await delay(100);
  await host.accept(command("next", "turn/steer", {
    inputId: "next-1",
    clientRequestId: "client-next-1",
    delivery: "next-turn",
    input: { text: "after the active turn" },
  }));
  await until(() => host.query("next"), (receipt) => receipt?.state === "accepted", "next-turn steer");
  await until(() => host.events(0), (events) => {
    const states = canonical(events).filter((event: any) =>
      event.kind === "input.state" && event.status.inputId === "next-1");
    return states.some((event: any) => event.status.delivery.value === "next-turn"
      && event.status.disposition === "next-turn");
  }, "next-turn delivery");
  await until(() => host.events(0), (events) =>
    canonical(events).filter((event: any) => event.kind === "turn.completed").length >= 3, "next-turn completion");

  await host.accept(command("close", "session/close"));
  await until(() => host.query("close"), (receipt) => receipt?.state === "accepted", "session close");
  const events = await host.events(0);
  const last = events.at(-1);
  if (last !== undefined) await host.ack(last.seq);
  await host.releaseThread("server-1", "thread-1");
});


test("session close clears a pending approval so the route can be released", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-host-close-"));
  const host = await BridgeHost.open({ path: join(root, "host.db"), policy, backend: localTestBackend() });
  t.after(async () => { await host.close().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  await host.add(await config(root, {
    ACP_FIXTURE_NATIVE_STEER: "0",
    ACP_FIXTURE_PERMISSION: "1",
    ACP_FIXTURE_DELAY_MS: "20",
  }));
  await host.activate("acp-g1", "");
  await host.accept(command("create", "session/create", { cwd: root, permissionMode: "auto" }));
  await until(() => host.query("create"), (receipt) => receipt?.state === "accepted", "session create");
  await host.accept(command("start", "turn/start", { input: { text: "needs approval" } }));
  await until(() => host.events(0), (events) =>
    events.some((event: any) => event.payload.method === "interaction/request"), "pending approval");
  await host.accept(command("close", "session/close"));
  await until(() => host.query("close"), (receipt) => receipt?.state === "accepted", "session close");
  const events = await host.events(0);
  const last = events.at(-1);
  if (last !== undefined) await host.ack(last.seq);
  await host.releaseThread("server-1", "thread-1");
});
