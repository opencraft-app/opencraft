import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DshAppServerAdapter } from "../../apps/local-agent-host/src/dsh-appserver-adapter.js";
import { DshExecutionAuthority } from "../../apps/local-agent-host/src/dsh-execution-authority.js";
import { dshInterruptedTurns } from "../../apps/local-agent-host/src/dsh-interrupted-turns.js";
import { InterruptedTurnRecovery } from "@opencraft/host-recovery";

test("a new accepted DSH turn remains recoverable while the previous turn's text is still paced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-recovery-pacing-"));
  const adapter = new DshAppServerAdapter({} as any);
  const authority = new DshExecutionAuthority(":memory:");
  const lifecycle = { catalog: { get: () => ({ ephemeral: false }) }, enqueue: async (_id: string, work: () => unknown) => work() } as any;
  const owned = dshInterruptedTurns(directory, adapter, authority, lifecycle, async () => {}, { connectionId: "system", identity: { id: "system", username: "System" } });
  const displayed: any[] = [];
  adapter.subscribe((method, params: any) => displayed.push({ method, params }));
  let seq = 0;
  // Feed the same native ingress boundary used by the DSH stream fixtures.
  const native = (type: string, data: any) => (adapter as any).onMuxFrame({ type: "session/event", sessionId: "s", event: { type, data, seq: ++seq, time: seq * 1000 } });
  let reopened: InterruptedTurnRecovery | undefined;
  try {
    native("turn/start", { turn: 1 });
    native("user/message", { id: "u1", content: [{ type: "text", text: "first" }] });
    native("assistant/chunk", { chunk: { type: "text-delta", index: 0, text: "answer".repeat(1000) } });
    native("turn/end", { reason: { kind: "completed" } });
    native("turn/start", { turn: 2 });
    assert.equal(displayed.filter(frame => frame.method === "turn/started").length, 1, "the second visible start is still behind paced text");
    await owned.close(); adapter.close();
    const recovered: string[] = [];
    reopened = new InterruptedTurnRecovery(directory, { serialize: async (_id, work) => work(), inspect: async () => "lost",
      continue: async (turn, _current, admit) => { if (!admit()) return null; recovered.push(turn.turnId); return "continued"; }, changed() {} });
    await reopened.recover();
    assert.deepEqual(recovered, ["dsh-turn-s-2"]);
  } finally { await owned.close(); adapter.close(); authority.close(); await reopened?.close(); await rm(directory, { recursive: true, force: true }); }
});
