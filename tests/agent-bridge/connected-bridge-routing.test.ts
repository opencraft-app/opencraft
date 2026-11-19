import test from "node:test";
import assert from "node:assert/strict";
import { ConnectedAgentHost } from "../../apps/local-agent-host/src/connected-agents.js";

for (const configured of [false, true]) test(`connected agent bridge is opt-in and preserves legacy owners (${configured})`, async t => {
  const calls: { owner: string; method: string; params: any }[] = [];
  let starts = 0;
  const provider = {
    ownsThread: (id: string) => id.startsWith("claude_bridge_"),
    async start() { starts++; },
    async close() {},
    async request(method: string, params: any) { calls.push({ owner: "bridge", method, params }); return {}; },
  };
  // Inject execution transports only: ownership and dispatch run through the real Host.
  const host = new ConnectedAgentHost({} as any, "/unused", "/fixture", {} as any,
    configured ? { provider: provider as any, engines: ["claude-code"] } : undefined);
  (host as any).engine = async (owner: string) => ({
    async request(method: string, params: any) { calls.push({ owner, method, params }); return {}; },
  });
  t.after(() => host.close());
  await host.start();
  assert.equal(starts, configured ? 1 : 0);
  assert.equal(host.owns("thread/start", { model: "claude-code:current" }), true);
  await host.dispatch("thread/start", { model: "claude-code:current", cwd: "/fixture" });
  assert.equal(calls.at(-1)?.owner, configured ? "bridge" : "claude-code");
  for (const [prefix, owner] of [["claude", "claude-code"], ["codex", "codex"], ["cursor", "cursor"], ["codebuddy", "codebuddy"]]) {
    await host.dispatch("thread/resume", { threadId: `${prefix}_legacy`, model: "claude-code:current" });
    assert.equal(calls.at(-1)?.owner, owner);
  }
  if (configured) {
    await host.dispatch("turn/steer", { threadId: "claude_bridge_new", expectedTurnId: "turn-1", clientUserMessageId: "input-1" });
    assert.equal(calls.at(-1)?.owner, "bridge");
    assert.equal(calls.at(-1)?.params.expectedTurnId, "turn-1");
    assert.equal(calls.at(-1)?.params.clientUserMessageId, "input-1");
  }
  assert.equal(host.owns("thread/resume", { threadId: "foreign_thread" }), false);
  await assert.rejects(host.dispatch("thread/resume", { threadId: "foreign_thread" }), /not owned/);
});
