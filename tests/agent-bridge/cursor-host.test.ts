import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { BridgeHost } from "../../apps/agent-bridge-host/src/index.js";
import { CURSOR_DECLARATION } from "../../apps/cursor-bridge/src/declaration.js";
import { localTestBackend } from "./fixtures/local-backend.js";
const artifact = resolve("tests/agent-bridge/fixtures/cursor-bridge.ts");
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await delay(10); }
  throw Error("Cursor Host condition timed out");
}
for (const trigger of ["eof", "opening-eof", "cancel-timeout", "signal", "broken-pipe"] as const) test(
  {
    eof: "Cursor stdio EOF never waits for new Host acknowledgements",
    "opening-eof": "Cursor stdio EOF cancels an SDK run with an unacknowledged Turn open",
    "cancel-timeout": "Cursor stdio EOF exits with failure if native cancellation never confirms",
    signal: "Cursor stdio SIGTERM joins cleanup after EOF",
    "broken-pipe": "Cursor stdio broken output pipe reclaims the native run",
  }[trigger]!,
  { skip: (trigger === "signal" || trigger === "broken-pipe") && process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cursor-stdio-close-"));
    const log = join(root, "native.log");
    const child = spawn(process.execPath, ["--import", "tsx", artifact], {
      cwd: resolve("."),
      env: { ...process.env, TMPDIR: root, CURSOR_FIXTURE_OUTCOME: "stdio-shutdown", CURSOR_FIXTURE_LOG: log },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const exited = once(child, "exit");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      await rm(root, { recursive: true, force: true });
    });
    const lines = createInterface({ input: child.stdout });
    const replies = new Map<string, { result?: unknown; error?: unknown }>();
    const callbacks: string[] = [];
    const send = (frame: Record<string, unknown>) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
    let unacknowledged = false;
    lines.on("line", line => {
      const frame = JSON.parse(line);
      if (!frame.method) { replies.set(frame.id, frame); return; }
      callbacks.push(frame.id);
      const heldOp = trigger === "opening-eof" ? "turn.open" : "item.open";
      if (frame.params?.deltas?.some((delta: { op: string }) => delta.op === heldOp)) unacknowledged = true;
      else if (child.stdin.writable) send({ id: frame.id, result: {} });
    });
    const rpc = async (method: string, params: unknown) => {
      send({ id: method, method, params });
      const frame = await until(async () => replies.get(method), Boolean);
      assert.equal(frame?.error, undefined);
    };
    await rpc("initialize", { protocolVersion: 1, grammarRange: { min: 1, max: 1 } });
    await rpc("session/create", { threadId: "thread", cwd: root, stateDirectory: root, model: "fixture", permissionMode: "full" });
    const startParams = { threadId: "thread", input: { text: "input", attachments: [{ data: "YQ==" }] } };
    if (trigger === "opening-eof") send({ id: "turn/start", method: "turn/start", params: startParams });
    else await rpc("turn/start", startParams);
    await until(async () => unacknowledged, Boolean);
    assert.ok((await readdir(root)).some(name => name.startsWith("cursor-input-")));
    const callbackCount = callbacks.length;

    const logged = () => readFile(log, "utf8").catch(() => "");
    if (trigger === "broken-pipe") {
      const disconnected = once(child.stdout, "close");
      child.stdout.destroy();
      await disconnected;
      send({ id: "probe-broken-output", method: "input/query", params: { threadId: "thread" } });
    } else child.stdin.end();
    await until(logged, value => value.includes("cancel\n"));
    if (trigger === "signal") {
      assert.equal(child.kill("SIGTERM"), true);
      await until(logged, value => value.includes("signal\n"));
      assert.equal(await Promise.race([exited.then(() => true), delay(75).then(() => false)]), false);
    }
    if (trigger !== "cancel-timeout") await writeFile(log + ".release", "");
    await until(async () => child.exitCode, value => value !== null, trigger === "cancel-timeout" ? 13_000 : 5000);
    assert.deepEqual(await exited, [trigger === "broken-pipe" || trigger === "cancel-timeout" ? 1 : 0, null]);
    const lifecycles = (await logged()).split("\n");
    assert.equal(lifecycles.filter(line => line === "cancel").length, 1);
    assert.equal(lifecycles.filter(line => line === "closed").length, trigger === "cancel-timeout" ? 0 : 1);
    assert.equal(callbacks.length, callbackCount);
    assert.ok(!(await readdir(root)).some(name => name.startsWith("cursor-input-")));
  },
);
for (const outcome of ["delivered", "followup", "unknown", "missing-key", "create-retry", "cleanup-retry", "close-retry", "preparing-cleanup", "start-preparation-retry", "start-stop-before-send", "start-stop-during-send"]) test(`Host projects Cursor ${outcome} truthfully and settles route`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-host-"));
  const host = await BridgeHost.open({ path: join(root, "host.db"), backend: localTestBackend(),
    policy: { id: "cursor-test", capacity: { cpuMillis: 16000, memoryBytes: 32 * 1024 ** 3 } } });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  await host.add({ id: "cursor", artifact, digest: createHash("sha256").update(await readFile(artifact)).digest("hex"),
    provider: CURSOR_DECLARATION, launch: { command: [process.execPath, "--import", "tsx", artifact], cwd: resolve("."),
      env: { PATH: process.env.PATH!, CURSOR_FIXTURE_OUTCOME: outcome, CURSOR_FIXTURE_AUTH: outcome === "missing-key" ? "missing" : "present", CURSOR_FIXTURE_LOG: join(root, "native.log"),
        ...(outcome.startsWith("start-") ? { TMPDIR: root, TEMP: root, TMP: root } : {}) } } });
  await host.activate("cursor", "");
  async function send(commandId: string, method: string, params: Record<string, unknown> = {}) {
    await host.accept({ commandId, method, params, serverId: "server", threadId: "thread" });
    return until(() => host.query(commandId), (r) => r?.state === "accepted" || r?.state === "unknown" || r?.state === "rejected");
  }
  let created = await send("create", "session/create", { cwd: root, stateDirectory: root, model: "fixture", permissionMode: "full" });
  if (outcome === "create-retry") {
    assert.equal(created?.state, "rejected");
    created = await send("create-second", "session/create", { cwd: root, stateDirectory: root, model: "fixture", permissionMode: "full" });
  }
  if (outcome === "missing-key") {
    assert.equal(created?.state, "rejected");
    const error = created?.response && "error" in created.response ? created.response.error : undefined;
    assert.equal(error?.kind, "auth"); assert.match(error?.message ?? "", /https:\/\/cursor.com\/dashboard\/api/);
    assert.match(error?.message ?? "", /CURSOR_API_KEY/); return;
  }
  assert.equal(created?.state, "accepted");
  if (outcome === "start-stop-before-send" || outcome === "start-stop-during-send") {
    const beforeSend = outcome === "start-stop-before-send";
    const log = join(root, "native.log");
    const files = () => readdir(root).then(names => names.filter(name => name.startsWith("cursor-input-")));
    const starting = send("start", "turn/start", { input: { text: "file", attachments: [{ data: "YQ==" }] } });
    void starting.catch(() => {});
    let stopping: ReturnType<typeof send> | undefined;
    try {
      await until(() => readFile(log, "utf8").catch(() => ""), text => text.includes(beforeSend ? "preparing\n" : "send\n"));
      assert.equal((await files()).length, 1);
      stopping = send("stop", "turn/stop");
      void stopping.catch(() => {});
      await until(files, names => names.length === 0);
    } finally {
      await writeFile(log + ".start-release", "");
      await Promise.allSettled([starting, stopping]);
    }
    const started = await starting;
    assert.equal((await stopping)?.state, "accepted");
    const events = (await host.events(0)).map((row: any) => row.payload.event)
      .filter((event: any) => event?.kind === "turn.started" || event?.kind === "turn.completed");
    if (beforeSend) {
      assert.equal(started?.state, "rejected");
      const error = started?.response && "error" in started.response ? started.response.error : undefined;
      assert.equal(error?.kind, "explicit-reject");
      assert.match(error?.message ?? "", /stopped before dispatch/i);
      assert.equal((await readFile(log, "utf8")).includes("send\n"), false);
      assert.deepEqual(events, []);
    } else {
      assert.equal(started?.state, "accepted");
      assert.deepEqual(events.map((event: any) => event.kind), ["turn.started", "turn.completed"]);
      assert.equal(events[1].status, "interrupted");
      assert.equal(events[0].turnId, started?.identities?.turn?.id);
      assert.equal(events[1].turnId, events[0].turnId);
      assert.equal((await readFile(log, "utf8")).split("\n").filter(line => line === "send").length, 1);
    }
    assert.equal((await send("close", "session/close"))?.state, "accepted");
    const all = await host.events(0);
    await host.ack(all.at(-1)!.seq);
    await host.releaseThread("server", "thread");
    return;
  }
  if (outcome === "start-preparation-retry") {
    const refused = await send("start-first", "turn/start", { input: { text: "file", attachments: [{ data: "YQ==" }] } });
    assert.equal(refused?.state, "rejected");
    const error = refused?.response && "error" in refused.response ? refused.response.error : undefined;
    assert.equal(error?.kind, "explicit-reject");
    assert.match(error?.message ?? "", /nothing was sent/i);
    assert.ok(!(await readdir(root)).some(name => name.startsWith("cursor-input-")));
    assert.ok(!(await readdir(root)).includes("native.log"), "preparation failed before any SDK send");
  }
  const started = await send("start", "turn/start", { input: { text: "main" } });
  assert.equal(started?.state, "accepted");
  const result = started?.response && "result" in started.response ? started.response.result as any : {};
  const params = { inputId: "steer-1", clientRequestId: "client-1", expectedTurnId: result.nativeTurnId,
    input: { text: "new instruction" } };
  if (outcome === "preparing-cleanup") {
    params.input = { text: "file", attachments: [{ data: "YQ==" }] } as any;
    await host.accept({ commandId: "preparing", method: "turn/steer", params, serverId: "server", threadId: "thread" });
    await until(() => host.events(0), (rows) => rows.some((e: any) => e.payload.event?.kind === "input.state"));
    assert.equal((await send("stop", "turn/stop"))?.state, "rejected");
    await until(() => host.query("preparing"), (r) => r?.state === "accepted");
    const states = (await host.events(0)).map((e: any) => e.payload.event).filter((e: any) => e?.kind === "input.state");
    assert.equal(states.at(-1).status.outcome, "withdrawn");
    await writeFile(join(root, "native.log.cleanup-ok"), "ready");
    assert.equal((await send("close", "session/close"))?.state, "accepted");
    const all = await host.events(0); await host.ack(all.at(-1)!.seq);
    await host.releaseThread("server", "thread");
    assert.equal((await readFile(join(root, "native.log"), "utf8")).includes("steer"), false);
    return;
  }
  assert.equal((await send("steer", "turn/steer", params))?.state, outcome === "unknown" ? "unknown" : "accepted");
  // The same Host command is a receipt query, never a second native mutation.
  assert.equal((await host.accept({ commandId: "steer", method: "turn/steer", params, serverId: "server", threadId: "thread" })).state, outcome === "unknown" ? "unknown" : "accepted");
  const events = await until(() => host.events(0), (events) => events.filter((e: any) => e.payload.event?.kind === "turn.completed").length === 1);
  const states = events.map((e: any) => e.payload.event).filter((e: any) => e?.kind === "input.state");
  assert.equal(states.at(-1).status.delivery.value, !["followup", "unknown"].includes(outcome) ? "native-inject" : "none");
  if (["followup", "unknown"].includes(outcome)) assert.equal(states.at(-1).status.outcome, outcome === "followup" ? "rejected" : "unknown");
  const executions = await readFile(join(root, "native.log"), "utf8");
  assert.equal(executions.split("\n").filter((line) => line === "steer").length, 1);
  assert.equal(executions.split("\n").filter((line) => line === "send").length, 1);
  assert.equal(states.some((e: any) => e.status.evidence.value === "context-confirmed"), false);
  if (outcome === "cleanup-retry") assert.equal((await send("stop", "turn/stop"))?.state, "rejected");
  if (outcome === "cleanup-retry" || outcome === "close-retry") {
    const refused = await send("close-first", "session/close");
    assert.equal(refused?.state, "rejected");
    assert.equal(refused?.response && "error" in refused.response ? refused.response.error?.kind : undefined, "explicit-reject");
    if (outcome === "cleanup-retry") await writeFile(join(root, "native.log.cleanup-ok"), "ready");
  }
  assert.equal((await send("close", "session/close"))?.state, "accepted");
  const all = await host.events(0); await host.ack(all.at(-1)!.seq);
  if (outcome === "unknown") await assert.rejects(host.releaseThread("server", "thread"), /unknown custody/);
  else await host.releaseThread("server", "thread");
});
