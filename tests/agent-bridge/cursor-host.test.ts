import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { BridgeHost } from "../../apps/agent-bridge-host/src/index.js";
import { CURSOR_DECLARATION } from "../../apps/cursor-bridge/src/declaration.js";
import { localTestBackend } from "./fixtures/local-backend.js";
const artifact = resolve("tests/agent-bridge/fixtures/cursor-bridge.ts");
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean) {
  for (let n=0;n<400;n++) { const value = await read(); if (predicate(value)) return value; await delay(10); }
  throw Error("Cursor Host condition timed out");
}
for (const outcome of ["delivered", "followup", "unknown", "missing-key", "create-retry"]) test(`Host projects Cursor ${outcome} truthfully and settles route`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-host-"));
  const host = await BridgeHost.open({ path: join(root, "host.db"), backend: localTestBackend(),
    policy: { id: "cursor-test", capacity: { cpuMillis: 16000, memoryBytes: 32 * 1024 ** 3 } } });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  await host.add({ id: "cursor", artifact, digest: createHash("sha256").update(await readFile(artifact)).digest("hex"),
    provider: CURSOR_DECLARATION, launch: { command: [process.execPath, "--import", "tsx", artifact], cwd: resolve("."),
      env: { PATH: process.env.PATH!, CURSOR_FIXTURE_OUTCOME: outcome, CURSOR_FIXTURE_AUTH: outcome === "missing-key" ? "missing" : "present", CURSOR_FIXTURE_LOG: join(root, "native.log") } } });
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
  const started = await send("start", "turn/start", { input: { text: "main" } });
  assert.equal(started?.state, "accepted");
  const result = started?.response && "result" in started.response ? started.response.result as any : {};
  const params = { inputId: "steer-1", clientRequestId: "client-1", expectedTurnId: result.nativeTurnId,
    input: { text: "new instruction" } };
  assert.equal((await send("steer", "turn/steer", params))?.state, outcome === "unknown" ? "unknown" : "accepted");
  // The same Host command is a receipt query, never a second native mutation.
  assert.equal((await host.accept({ commandId: "steer", method: "turn/steer", params, serverId: "server", threadId: "thread" })).state, outcome === "unknown" ? "unknown" : "accepted");
  const events = await until(() => host.events(0), (events) => events.filter((e: any) => e.payload.event?.kind === "turn.completed").length === 1);
  const states = events.map((e: any) => e.payload.event).filter((e: any) => e?.kind === "input.state");
  assert.equal(states.at(-1).status.delivery.value, outcome === "delivered" || outcome === "create-retry" ? "native-inject" : "none");
  if (outcome !== "delivered" && outcome !== "create-retry") assert.equal(states.at(-1).status.outcome, outcome === "followup" ? "rejected" : "unknown");
  const executions = await readFile(join(root, "native.log"), "utf8");
  assert.equal(executions.split("\n").filter((line) => line === "steer").length, 1);
  assert.equal(executions.split("\n").filter((line) => line === "send").length, 1);
  assert.equal(states.some((e: any) => e.status.evidence.value === "context-confirmed"), false);
  await send("close", "session/close");
  const all = await host.events(0); await host.ack(all.at(-1)!.seq);
  if (outcome === "unknown") await assert.rejects(host.releaseThread("server", "thread"), /unknown custody/);
  else await host.releaseThread("server", "thread");
});
