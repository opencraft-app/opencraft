import assert from "node:assert/strict";
import test from "node:test";
import {
  codexBridgeConversationTools,
  codexBridgeCreationTools,
} from "../../apps/opencraft-daemon/src/codex-bridge-conversation-tools.js";

const context = { threadId: "bridge:codex:one", turnId: "turn", callId: "call" };
const signal = new AbortController().signal;

test("bridge Threads get the local Host conversation tools, answered by the collaboration owner", async () => {
  assert.deepEqual(
    codexBridgeCreationTools()
      .map((tool) => tool.name)
      .sort(),
    ["get_thread_delivery", "read_thread", "send_message_to_thread"],
  );
  assert.ok(codexBridgeCreationTools().every((tool) => tool.type === "function"));
  const calls: unknown[] = [];
  const browser = (_context: unknown, tool: { name: string }) =>
    tool.name === "browser_open" ? Promise.resolve({ success: true, contentItems: [] }) : null;
  const dispatch = codexBridgeConversationTools(
    {
      tool(threadId, turnId, name, args) {
        calls.push([threadId, turnId, name, args]);
        if (name === "get_thread_delivery") throw Object.assign(Error("private"), { status: 404 });
        return { ok: true };
      },
    },
    browser,
  );
  assert.deepEqual(await dispatch(context, { namespace: null, name: "read_thread" }, { target: "x" }, signal), {
    success: true,
    contentItems: [{ type: "inputText", text: '{"ok":true}' }],
  });
  assert.deepEqual(calls[0], ["bridge:codex:one", "turn", "read_thread", { target: "x" }]);
  const refused: any = await dispatch(context, { namespace: null, name: "get_thread_delivery" }, {}, signal);
  assert.equal(refused.success, false);
  assert.deepEqual(JSON.parse(refused.contentItems[0].text), {
    error: "Conversation operation unavailable or unauthorized. Inspect the original receipt before retrying.",
    status: 404,
  });
  // Orchestration needs Core's callback lane: answered as unavailable, never left to a client.
  const orchestration: any = await dispatch(context, { namespace: null, name: "thread_spawn" }, {}, signal);
  assert.equal(orchestration.success, false);
  assert.equal(JSON.parse(orchestration.contentItems[0].text).status, 503);
  assert.ok(await dispatch(context, { namespace: null, name: "browser_open" }, {}, signal));
  assert.equal(dispatch(context, { namespace: null, name: "client_tool" }, {}, signal), null);
  // A namespaced tool of the same name is not a conversation tool.
  assert.equal(dispatch(context, { namespace: "mcp", name: "read_thread" }, {}, signal), null);
});
