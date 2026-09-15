import assert from "node:assert/strict";
import test from "node:test";
import apply, { sanitizeRollout } from "../plugins/rollout-item-portability/index.js";

function rollout(provider, id = "rs_resp_chat_0000000000000c81") {
  return Buffer.from([
    JSON.stringify({ type: "session_meta", payload: { id: "thread-a", model_provider: provider } }),
    JSON.stringify({ type: "response_item", payload: { type: "reasoning", id, summary: [] } }),
    "",
  ].join("\n"));
}

test("the hot plugin strips synthetic response ids during a provider handoff", () => {
  const files = new Map([["/source.jsonl", rollout("hypernode-public-kimi-k3")]]);
  const driver = {
    readFile: (path) => files.get(path),
    writeFile: (path, bytes) => files.set(path, Buffer.from(bytes)),
  };
  const service = {
    table: { driver },
    readSource: (path) => files.get(path),
    prepare() {
      files.set("/destination.jsonl", Buffer.from(files.get("/source.jsonl")));
      return { threadId: "outer-a", path: "/destination.jsonl" };
    },
    ensureModelProvider() { return { changed: true, responseItemIdsStripped: 0 }; },
    discard() {},
  };
  let dispose;
  apply({ threadArtifactStore: service, effect(callback) { dispose = callback(); } });
  service.prepare("outer-a", "/source.jsonl", 1, "thread-a", { modelProvider: "openai" });
  assert.doesNotMatch(files.get("/destination.jsonl").toString("utf8"), /rs_resp_chat_/);
  dispose();
});

test("same-provider resumes also remove locally synthetic ids", () => {
  const sanitized = sanitizeRollout(rollout("openai"));
  assert.equal(sanitized.stripped, 1);
  assert.doesNotMatch(sanitized.bytes.toString("utf8"), /rs_resp_chat_/);
});
