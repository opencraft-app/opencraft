import assert from "node:assert/strict";
import test from "node:test";

import { createSurfaceCheckpoint } from "../apps/local-agent-host/src/hypernode/surface-checkpoint.mjs";
import { isSurfaceEvent } from "../runtime/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js";
const { advanceSurface, surfaceToSeed } = createSurfaceCheckpoint(isSurfaceEvent);

function user(seq, text) {
  return {
    type: "user/message", seq, time: seq,
    data: { role: "user", content: [{ type: "text", text }], source: { kind: "user" } },
    surfaceOp: "append",
  };
}

function assistant(seq, content) {
  return {
    type: "assistant/message", seq, time: seq,
    data: {
      turn: 1, step: 1,
      message: { role: "assistant", content, source: { provider: "p", model: "m" } },
    },
    surfaceOp: "append",
  };
}

test("surface checkpoint advances from its watermark without replaying its prefix", () => {
  const prefix = [user(2, "old"), assistant(5, [{ type: "text", text: "answer" }])];
  const replacement = {
    ...user(9, "compacted"),
    surfaceOp: { op: "replace", start: 2, end: 5 },
    sourceEventSeqs: [2, 5],
  };
  const result = advanceSurface(prefix, [
    { type: "turn/start", seq: 8, time: 8, data: { turn: 2 } },
    replacement,
    assistant(10, [{ type: "text", text: "tail" }]),
  ]);

  assert.deepEqual(result.map(event => event.seq), [9, 10]);
  assert.equal(result[0].data.content[0].text, "compacted");
});

test("surface seed reconstructs native tool-call relations and turn boundaries", () => {
  const surface = [
    user(1, "inspect"),
    assistant(3, [
      { type: "text", text: "checking" },
      { type: "tool-call", id: "call_1", name: "bash", arguments: { command: "pwd" } },
    ]),
    {
      type: "tool/result", seq: 5, time: 5,
      data: {
        turn: 1, step: 1,
        message: {
          role: "user",
          content: [{ type: "tool-result", toolCallId: "call_1", content: [{ type: "text", text: "/workspace" }], isError: false }],
          source: { kind: "tool", callId: "call_1" },
        },
      },
      surfaceOp: "append",
    },
    assistant(7, [{ type: "text", text: "done" }]),
    user(11, "next"),
    assistant(13, [{ type: "text", text: "second" }]),
  ];
  const seed = surfaceToSeed(surface);

  assert.deepEqual(seed.map(event => event.seq), seed.map((_, index) => index));
  assert.equal(seed.filter(event => event.type === "turn/start").length, 2);
  assert.equal(seed.filter(event => event.type === "step/start").length, 3);
  const call = seed.find(event => event.type === "tool/call");
  const result = seed.find(event => event.type === "tool/result");
  assert.equal(call.data.callId, "call_1");
  assert.deepEqual(result.sourceEventSeqs, [call.seq]);
  assert.deepEqual(seed.at(-1).data.reason, { kind: "completed" });
});

test("surface seed marks a crash tail as interrupted", () => {
  const seed = surfaceToSeed([
    user(1, "work"),
    assistant(3, [{ type: "text", text: "partial" }]),
  ], { interrupted: true });

  assert.deepEqual(seed.at(-1).data.reason, { kind: "interrupted" });
});
