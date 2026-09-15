import assert from "node:assert/strict";
import test from "node:test";

import {
  resumeHistoryFromRollout,
  sanitizeRolloutResponseItemIds,
  ThreadArtifactTable,
  transformRolloutForHandoff,
  rewriteRolloutIdentity,
  rewriteRolloutModelProvider,
} from "../src/services/thread-artifact-store.js";

function driver() {
  const calls = [];
  const files = new Map();
  const counts = { reads: 0, writes: 0 };
  return {
    enabled: true,
    calls,
    files,
    counts,
    createDirectory: (...args) => calls.push(["mkdir", ...args]),
    importArtifact: (source, destination) => {
      calls.push(["import", source, destination]);
      files.set(destination, files.get(source));
    },
    copy: (source, destination, recursive) => {
      calls.push(["copy", source, destination, recursive]);
      files.set(destination, files.get(source));
    },
    readFile: (path) => {
      counts.reads += 1;
      return files.get(path);
    },
    readLegacyArtifact: (path) => {
      counts.reads += 1;
      calls.push(["readLegacy", path]);
      return files.get(path);
    },
    writeFile: (path, bytes) => {
      counts.writes += 1;
      files.set(path, bytes);
    },
    remove: (...args) => calls.push(["remove", ...args]),
    findUserRollout: (home, threadId) => `${home}/.codex/sessions/rollout-${threadId}.jsonl`,
  };
}

const SOURCE_ID = "0198f8a0-1111-7000-8000-000000000001";
const TARGET_ID = "0198f8a0-2222-7000-8000-000000000002";

function rollout(threadId = SOURCE_ID) {
  return Buffer.from([
    JSON.stringify({
      timestamp: "2026-08-26T00:00:00.000Z",
      type: "session_meta",
      payload: { session_id: threadId, id: threadId, cwd: "/workspace/projects/demo" },
    }),
    JSON.stringify({ timestamp: "2026-08-26T00:00:01.000Z", type: "response_item", payload: { id: "message-1" } }),
    "",
  ].join("\n"));
}

test("rollout reidentification changes only canonical session identity", () => {
  const rewritten = rewriteRolloutIdentity(rollout(), TARGET_ID, SOURCE_ID);
  const lines = Buffer.from(rewritten.bytes).toString("utf8").trimEnd().split("\n");
  const metadata = JSON.parse(lines[0]);
  assert.equal(metadata.payload.id, TARGET_ID);
  assert.equal(metadata.payload.session_id, TARGET_ID);
  assert.equal(metadata.payload.forked_from_id, SOURCE_ID);
  assert.equal(JSON.parse(lines[1]).payload.id, "message-1");
  assert.equal(rewritten.previousThreadId, SOURCE_ID);
});

test("rollout reidentification rejects a source identity mismatch", () => {
  assert.throws(
    () => rewriteRolloutIdentity(rollout(), TARGET_ID, "0198f8a0-3333-7000-8000-000000000003"),
    /identity mismatch/,
  );
});

test("rollout provider rewrite updates every session incarnation", () => {
  const source = Buffer.from([
    JSON.stringify({ type: "session_meta", payload: { id: SOURCE_ID, model_provider: "openai" } }),
    JSON.stringify({ type: "response_item", payload: { id: "message-1" } }),
    JSON.stringify({ type: "session_meta", payload: { id: SOURCE_ID, model_provider: "openai" } }),
    "",
  ].join("\n"));
  const rewritten = rewriteRolloutModelProvider(source, "hypernode-public-kimi-k3");
  const records = Buffer.from(rewritten.bytes).toString("utf8").trimEnd().split("\n").map(JSON.parse);
  assert.equal(rewritten.changed, true);
  assert.equal(rewritten.sessionMetaCount, 2);
  assert.deepEqual(
    records.filter((record) => record.type === "session_meta")
      .map((record) => record.payload.model_provider),
    ["hypernode-public-kimi-k3", "hypernode-public-kimi-k3"],
  );
  assert.equal(records[1].payload.id, "message-1");
});

test("rollout sanitization strips foreign item ids without breaking tool call pairing", () => {
  const source = Buffer.from([
    JSON.stringify({ type: "session_meta", payload: { id: SOURCE_ID } }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        id: "exec_command:0",
        call_id: "exec_command:0",
        name: "exec_command",
        arguments: "{}",
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        id: "fco_valid",
        call_id: "exec_command:0",
        output: "done",
      },
    }),
    "",
  ].join("\n"));

  const sanitized = sanitizeRolloutResponseItemIds(source);
  const records = Buffer.from(sanitized.bytes).toString("utf8").trimEnd().split("\n").map(JSON.parse);
  assert.equal(sanitized.changed, true);
  assert.equal(sanitized.stripped, 1);
  assert.equal("id" in records[1].payload, false);
  assert.equal(records[1].payload.call_id, "exec_command:0");
  assert.equal(records[2].payload.id, "fco_valid");
  assert.equal(records[2].payload.call_id, "exec_command:0");

  const second = sanitizeRolloutResponseItemIds(sanitized.bytes);
  assert.equal(second.changed, false);
  assert.equal(second.stripped, 0);
});

test("rollout sanitization rejects valid-looking ids from a foreign item namespace", () => {
  const source = Buffer.from([
    JSON.stringify({
      type: "compacted",
      payload: {
        replacement_history: [
          { type: "message", id: "msg_valid", role: "assistant", content: [] },
          { type: "function_call", id: "call_foreign", call_id: "call_foreign" },
          { type: "item_reference", id: "remote:required" },
        ],
      },
    }),
  ].join("\n"));

  const sanitized = sanitizeRolloutResponseItemIds(source);
  const replacement = JSON.parse(Buffer.from(sanitized.bytes).toString("utf8"))
    .payload.replacement_history;
  assert.equal(replacement[0].id, "msg_valid");
  assert.equal("id" in replacement[1], false);
  assert.equal(replacement[1].call_id, "call_foreign");
  assert.equal(replacement[2].id, "remote:required");
});

test("rollout sanitization strips gateway ids that imitate native Responses prefixes", () => {
  const source = Buffer.from([
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "reasoning",
        id: "rs_resp_chat_0000000000000014",
        summary: [{ type: "summary_text", text: "local gateway reasoning" }],
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        id: "msg_hypernode_finish_1234",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "reasoning",
        id: "rs_native_provider_owned",
        summary: [],
      },
    }),
    "",
  ].join("\n"));

  const sanitized = sanitizeRolloutResponseItemIds(source);
  const records = Buffer.from(sanitized.bytes).toString("utf8")
    .trimEnd().split("\n").map(JSON.parse);
  assert.equal(sanitized.changed, true);
  assert.equal(sanitized.stripped, 2);
  assert.equal("id" in records[0].payload, false);
  assert.deepEqual(records[0].payload.summary, [
    { type: "summary_text", text: "local gateway reasoning" },
  ]);
  assert.equal("id" in records[1].payload, false);
  assert.equal(records[1].payload.content[0].text, "done");
  assert.equal(records[2].payload.id, "rs_native_provider_owned");
});

test("provider transitions strip every remote item identity regardless of its spelling", () => {
  const source = Buffer.from([
    JSON.stringify({ type: "session_meta", payload: { id: SOURCE_ID, model_provider: "kimi" } }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "reasoning", id: "rs_perfectly_native_looking", summary: [] },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call", id: "fc_native", call_id: "call_pair", name: "exec_command",
        arguments: "{}",
      },
    }),
    "",
  ].join("\n"));
  const rewritten = rewriteRolloutModelProvider(source, "openai");
  const sanitized = sanitizeRolloutResponseItemIds(rewritten.bytes, {
    stripProviderOwned: rewritten.changed,
  });
  const records = Buffer.from(sanitized.bytes).toString("utf8")
    .trimEnd().split("\n").map(JSON.parse);
  assert.equal(sanitized.stripped, 2);
  assert.equal("id" in records[1].payload, false);
  assert.equal("id" in records[2].payload, false);
  assert.equal(records[2].payload.call_id, "call_pair");
});

test("provider transitions fail closed when history contains only an opaque item reference", () => {
  const source = Buffer.from([
    JSON.stringify({ type: "session_meta", payload: { id: SOURCE_ID, model_provider: "kimi" } }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "item_reference", id: "rs_remote_only" },
    }),
    "",
  ].join("\n"));
  const rewritten = rewriteRolloutModelProvider(source, "openai");
  assert.throws(
    () => sanitizeRolloutResponseItemIds(rewritten.bytes, { stripProviderOwned: true }),
    /non-portable item_reference: rs_remote_only/,
  );
});

test("paginated rollouts project resumable ResponseItem history", () => {
  const first = {
    type: "message", role: "user", content: [{ type: "input_text", text: "hello" }],
  };
  const second = {
    type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }],
  };
  const bytes = Buffer.from([
    JSON.stringify({ type: "session_meta", payload: { id: SOURCE_ID, history_mode: "paginated" } }),
    JSON.stringify({ type: "response_item", payload: first }),
    JSON.stringify({ type: "response_item", payload: second }),
    "",
  ].join("\n"));
  assert.deepEqual(resumeHistoryFromRollout(bytes), [first, second]);
});

test("legacy rollouts keep using path resume", () => {
  assert.equal(resumeHistoryFromRollout(rollout()), null);
});

test("single-pass handoff keeps legacy tolerance for metadata without a payload", () => {
  const source = Buffer.from([
    JSON.stringify({ type: "session_meta" }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user" } }),
    "",
  ].join("\n"));
  const transformed = transformRolloutForHandoff(source);
  assert.equal(transformed.changed, false);
  assert.equal(transformed.resumeHistory, null);
  assert.equal(transformed.parsedLines, 2);
});

test("handoff transformation parses each JSONL record once and preserves all rewrite semantics", () => {
  const replacement = [{
    type: "message", id: "msg_native", role: "assistant", content: [],
  }];
  const source = Buffer.from([
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: SOURCE_ID,
        session_id: SOURCE_ID,
        model_provider: "kimi",
        history_mode: "paginated",
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "function_call", id: "fc_native", call_id: "call-1" },
    }),
    JSON.stringify({ type: "compacted", payload: { replacement_history: replacement } }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "message", id: "msg_native_2", role: "assistant", content: [] },
    }),
    "",
  ].join("\n"));

  const transformed = transformRolloutForHandoff(source, {
    nextThreadId: TARGET_ID,
    expectedThreadId: SOURCE_ID,
    modelProvider: "openai",
  });
  const legacyIdentity = rewriteRolloutIdentity(source, TARGET_ID, SOURCE_ID);
  const legacyProvider = rewriteRolloutModelProvider(legacyIdentity.bytes, "openai");
  const legacySanitized = sanitizeRolloutResponseItemIds(legacyProvider.bytes, {
    stripProviderOwned: legacyProvider.changed,
  });
  assert.deepEqual(transformed.bytes, legacySanitized.bytes);
  assert.deepEqual(transformed.resumeHistory, resumeHistoryFromRollout(legacySanitized.bytes));
  const records = Buffer.from(transformed.bytes).toString("utf8")
    .trimEnd().split("\n").map(JSON.parse);
  assert.equal(transformed.parsedLines, 4);
  assert.equal(transformed.providerChanged, true);
  assert.equal(transformed.stripped, 3);
  assert.equal(records[0].payload.id, TARGET_ID);
  assert.equal(records[0].payload.session_id, TARGET_ID);
  assert.equal(records[0].payload.forked_from_id, SOURCE_ID);
  assert.equal(records[0].payload.model_provider, "openai");
  assert.equal("id" in records[1].payload, false);
  assert.equal("id" in records[2].payload.replacement_history[0], false);
  assert.equal("id" in records[3].payload, false);
  assert.deepEqual(transformed.resumeHistory, [
    records[2].payload.replacement_history[0],
    records[3].payload,
  ]);
});

test("source reads preserve the host/workspace ownership boundary", () => {
  const io = driver();
  const table = new ThreadArtifactTable({ driver: io, hostMount: null });
  const legacy = "/data/hypernode/.runtime/users/alice/.codex/sessions/rollout-source.jsonl";
  const artifact = "/workspace/.hypernode/threads/outer-a/generation-1.jsonl";
  io.files.set(legacy, Buffer.from("legacy"));
  io.files.set(artifact, Buffer.from("artifact"));

  assert.equal(table.readSource(legacy).toString(), "legacy");
  assert.equal(table.readSource(artifact).toString(), "artifact");
  assert.deepEqual(io.calls, [["readLegacy", legacy]]);
});

test("rollout compaction replaces earlier history before appending later items", () => {
  const replacement = [{
    type: "message", role: "assistant", content: [{ type: "output_text", text: "summary" }],
  }];
  const later = {
    type: "message", role: "user", content: [{ type: "input_text", text: "continue" }],
  };
  const bytes = Buffer.from([
    JSON.stringify({ type: "session_meta", payload: { id: SOURCE_ID, history_mode: "paginated" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [] } }),
    JSON.stringify({ type: "compacted", payload: { replacement_history: replacement } }),
    JSON.stringify({ type: "response_item", payload: later }),
  ].join("\n"));
  assert.deepEqual(resumeHistoryFromRollout(bytes), [...replacement, later]);
});

test("empty paginated rollouts fail instead of silently losing context", () => {
  const bytes = Buffer.from(JSON.stringify({
    type: "session_meta", payload: { id: SOURCE_ID, history_mode: "paginated" },
  }));
  assert.throws(() => resumeHistoryFromRollout(bytes), /no resumable response history/);
});

test("first handoff imports a private rollout and commits a generation", () => {
  const host = driver();
  const source = "/data/users/alice/.codex/sessions/rollout.jsonl";
  host.files.set(source, rollout());
  let saved;
  const table = new ThreadArtifactTable({
    driver: host,
    hostMount: "/data/workspace",
    createThreadId: () => TARGET_ID,
    save: (value) => { saved = value; },
  });
  const artifact = table.prepare("thread-1", source, 1, SOURCE_ID, { reidentify: true });
  assert.equal(artifact.generation, 2);
  assert.deepEqual(host.calls.at(-1), ["readLegacy", source]);
  assert.equal(host.counts.reads, 1);
  assert.equal(host.counts.writes, 1);
  assert.equal(artifact.innerThreadId, TARGET_ID);
  table.commit(artifact, "chatgpt:b", 1, "user:bob");
  assert.equal(saved.records[0].path, artifact.path);
  assert.equal(saved.records[0].innerThreadId, TARGET_ID);
  assert.equal(saved.records[0].ownerUserId, "user:bob");
  assert.deepEqual([...table.values()], saved.records);
  assert.equal(table.runtimePath(artifact.path, "localhost"), `/data/workspace${artifact.path.slice("/workspace".length)}`);
});

test("legacy bindings can discover their rollout without the old account reconnecting", () => {
  const table = new ThreadArtifactTable({ driver: driver(), hostMount: "/data/workspace" });
  assert.equal(
    table.findLegacySource({ homePath: "/data/users/alice" }, "thread-1"),
    "/data/users/alice/.codex/sessions/rollout-thread-1.jsonl",
  );
});

test("later reidentified handoff reads and writes one workspace generation once", () => {
  const host = driver();
  const source = "/data/users/alice/rollout.jsonl";
  host.files.set(source, rollout());
  let nextId = TARGET_ID;
  const table = new ThreadArtifactTable({
    driver: host,
    hostMount: "/data/workspace",
    createThreadId: () => nextId,
  });
  const first = table.prepare("thread-1", source, 1, SOURCE_ID, { reidentify: true });
  table.commit(first, "chatgpt:a", 1);
  nextId = "0198f8a0-4444-7000-8000-000000000004";
  const second = table.prepare(
    "thread-1",
    "/data/workspace/.hypernode/threads/thread-1/generation-2.jsonl",
    2,
    TARGET_ID,
    { reidentify: true },
  );
  assert.equal(second.parentGeneration, 2);
  assert.equal(second.innerThreadId, nextId);
  assert.equal(host.counts.reads, 2);
  assert.equal(host.counts.writes, 2);
  assert.deepEqual(host.files.get(second.path) !== undefined, true);
});

test("dedicated runtime handoff preserves the inner identity and reflink contents", () => {
  const host = driver();
  const source = "/data/users/alice/rollout.jsonl";
  host.files.set(source, rollout());
  const table = new ThreadArtifactTable({
    driver: host,
    hostMount: "/data/workspace",
    createThreadId: assert.fail,
  });
  const artifact = table.prepare("thread-1", source, 1, SOURCE_ID);
  assert.equal(artifact.innerThreadId, SOURCE_ID);
  assert.equal(artifact.reidentified, false);
  assert.deepEqual(host.files.get(artifact.path), host.files.get(source));
  assert.deepEqual(host.calls.slice(-2), [
    ["readLegacy", source],
    ["import", source, artifact.path],
  ]);
  assert.equal(table.resumeHistory(artifact.path), null);
});

test("artifact preparation and repair persist the selected provider in rollout metadata", () => {
  const host = driver();
  const source = "/data/users/alice/rollout.jsonl";
  host.files.set(source, rollout());
  const table = new ThreadArtifactTable({ driver: host, hostMount: "/data/workspace" });
  const artifact = table.prepare("thread-1", source, 1, SOURCE_ID, {
    modelProvider: "hypernode-public-kimi-k3",
  });
  let metadata = JSON.parse(Buffer.from(host.files.get(artifact.path)).toString("utf8").split("\n")[0]);
  assert.equal(metadata.payload.model_provider, "hypernode-public-kimi-k3");
  const repaired = table.ensureModelProvider(artifact.path, "openai");
  assert.equal(repaired.changed, true);
  metadata = JSON.parse(Buffer.from(host.files.get(artifact.path)).toString("utf8").split("\n")[0]);
  assert.equal(metadata.payload.model_provider, "openai");
});

test("artifact preparation reads a large rollout once and reuses its resume history", () => {
  const host = driver();
  const source = "/data/users/alice/rollout.jsonl";
  const records = [JSON.stringify({
    type: "session_meta",
    payload: { id: SOURCE_ID, model_provider: "kimi", history_mode: "legacy" },
  })];
  for (let index = 0; index < 12_000; index += 1) {
    records.push(JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        id: `msg_provider_${index}`,
        role: "assistant",
        content: [{ type: "output_text", text: "x".repeat(300) }],
      },
    }));
  }
  const largeRollout = Buffer.from(`${records.join("\n")}\n`);
  assert.ok(largeRollout.length > 5_000_000);
  host.files.set(source, largeRollout);
  const table = new ThreadArtifactTable({ driver: host, hostMount: "/data/workspace" });

  const artifact = table.prepare("thread-1", source, 1, SOURCE_ID, {
    modelProvider: "openai",
  });

  assert.equal(host.counts.reads, 1);
  assert.equal(host.counts.writes, 1);
  assert.equal(artifact.resumeHistory, null);
  assert.equal(artifact.transformStats.parsedLines, 12_001);
  assert.equal(artifact.transformStats.strippedResponseItemIds, 12_000);
});

test("artifact preparation removes foreign Responses item ids before account handoff", () => {
  const host = driver();
  const source = "/data/users/alice/rollout.jsonl";
  host.files.set(source, Buffer.from([
    JSON.stringify({
      type: "session_meta",
      payload: { id: SOURCE_ID, model_provider: "hypernode-public-kimi-k3" },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "function_call", id: "exec_command:0", call_id: "exec_command:0" },
    }),
    "",
  ].join("\n")));
  const table = new ThreadArtifactTable({ driver: host, hostMount: "/data/workspace" });
  const artifact = table.prepare("thread-1", source, 1, SOURCE_ID, { modelProvider: "openai" });
  const records = Buffer.from(host.files.get(artifact.path)).toString("utf8")
    .trimEnd().split("\n").map(JSON.parse);
  assert.equal(records[0].payload.model_provider, "openai");
  assert.equal("id" in records[1].payload, false);
  assert.equal(records[1].payload.call_id, "exec_command:0");
});
