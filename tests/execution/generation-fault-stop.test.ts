import assert from "node:assert/strict";
import test from "node:test";
import { stopFailedGeneration, type FaultStopPort, type FaultUnitState } from "../../apps/codex-core/src/generation-fault-stop.js";
import type { GenerationProcessIdentity } from "../../apps/codex-core/src/generation-supervisor.js";

const source: GenerationProcessIdentity = {ownerPid: 10, ownerStart: "birth-owner", nativePid: 11, nativeStart: "birth-native",
  cliSha256: "fixed", cliVersion: "fixed", unit: "one.service", invocationId: "source-invocation"};
function fixture() {
  let state: FaultUnitState = {pid: 10, active: "active", invocationId: source.invocationId}, now = 0;
  const births = new Map([[10, source.ownerStart], [11, source.nativeStart]]);
  const actions: string[] = [];
  const port: FaultStopPort = {state: async () => state, birth: async pid => births.get(pid) ?? null,
    stop: async () => {actions.push("stop"); state = {...state, active: "deactivating"};},
    kill: async () => {actions.push("kill"); births.clear(); state = {pid: 0, active: "inactive"};},
    now: () => now, wait: async () => {now += 100;}};
  return {port, actions, births, state: (value: FaultUnitState) => {state = value;}};
}

test("fault stop is bounded without waiting for native health or busy work to finish", async () => {
  const f = fixture(); await stopFailedGeneration(source, f.port);
  assert.deepEqual(f.actions, ["stop", "kill"]);
  assert.equal(f.births.size, 0);
});
test("a controller replacement resumes a stop with MainPID zero while the original native is alive", async () => {
  const f = fixture(); f.births.delete(10); f.state({pid: 0, active: "deactivating", invocationId: source.invocationId});
  await stopFailedGeneration(source, f.port);
  assert.deepEqual(f.actions, ["stop", "kill"]);
});
test("already-stopped source is confirmed without signaling another instance", async () => {
  const f = fixture(); f.births.clear(); f.state({pid: 0, active: "inactive"});
  await stopFailedGeneration(source, f.port); assert.deepEqual(f.actions, []);
});
test("a reused owner PID or a new systemd invocation is never killed", async () => {
  const f = fixture(); f.births.set(10, "successor-birth"); f.births.delete(11);
  f.state({pid: 10, active: "active", invocationId: "successor-invocation"});
  await stopFailedGeneration(source, f.port); assert.deepEqual(f.actions, []);
});
test("source surviving outside its unit keeps recovery unconfirmed", async () => {
  const f = fixture(); f.state({pid: 12, active: "active", invocationId: "successor"});
  await assert.rejects(stopFailedGeneration(source, f.port), /no longer belongs/);
  assert.deepEqual(f.actions, []);
});
test("an unresponsive stop fails within its deadline and never releases source custody", async () => {
  const f = fixture(); f.port.kill = async () => {f.actions.push("unconfirmed-kill");};
  await assert.rejects(stopFailedGeneration(source, f.port), /stop is unconfirmed/);
  assert.deepEqual(f.actions, ["stop", "unconfirmed-kill"]);
  assert.equal(f.births.get(11), source.nativeStart);
});
