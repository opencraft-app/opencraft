import assert from "node:assert/strict";
import test from "node:test";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline } from "../../packages/chat-core/src/index";
import {
  parseRealtimeDelegation, realtimeDelegationText, realtimeDelegationHandoffId,
} from "../../packages/chat-core/src/realtime-transcript";

const envelope = (body: string) => `<realtime_delegation>${body}</realtime_delegation>`;

test("realtime text retains empty typed parts and ignores other input shapes", () => {
  assert.equal(realtimeDelegationText(["a", { type: "text", text: "" }, { type: "text", text: "b" }, { type: "input_text", text: "hidden" }, null]), "a\n\nb");
  for (const value of [null, 42, {}, { text: "hidden" }]) assert.equal(realtimeDelegationText(value), "");
  assert.equal(realtimeDelegationText("  literal  "), "  literal  ");
});

test("realtime envelope requires exact tags and keeps first-tag protocol behavior", () => {
  for (const value of [null, "", envelope("<input/>"), envelope('<input x="1">x</input>'),
    `<REALTIME_DELEGATION><input>x</input></REALTIME_DELEGATION>`, `prefix${envelope("<input>x</input>")}`]) {
    assert.equal(parseRealtimeDelegation(value), null);
  }
  assert.deepEqual(parseRealtimeDelegation(` \n${envelope("ignored<input> x </input><input>y</input>")}\n`), {
    input: "x", source: null, transcript: [{ role: "user", text: "x" }], transcriptDelta: null,
  });
  assert.equal(parseRealtimeDelegation(envelope("<transcript_delta>user: x</transcript_delta>")), null);
});

test("realtime entities decode once and literal markup remains data", () => {
  const result = parseRealtimeDelegation(envelope("<source> transcript_tail_flush </source><transcript_delta></transcript_delta><input>&lt;b&gt; &amp;lt; &quot; &apos; &#65;</input>"));
  assert.deepEqual(result, {
    input: '<b> &lt; " \' &#65;', source: "transcript_tail_flush",
    transcript: [{ role: "user", text: '<b> &lt; " \' &#65;' }], transcriptDelta: "",
  });
  assert.equal(parseRealtimeDelegation(envelope("<source>TRANSCRIPT_TAIL_FLUSH</source><input></input>"))?.source, null);
});

test("realtime roles retain multiline content, omit empty entries and deduplicate final input", () => {
  const delta = "ignored\r\nassistant:\r\nA reply\r\n\r\n  user: indented text\r\nsystem: more text\r\nUSER: latest";
  const result = parseRealtimeDelegation(envelope(`<transcript_delta>${delta}</transcript_delta><input>latest</input>`));
  assert.deepEqual(result?.transcript, [
    { role: "assistant", text: "A reply\n\n  user: indented text\nsystem: more text" },
    { role: "user", text: "latest" },
  ]);
  assert.deepEqual(parseRealtimeDelegation(envelope("<transcript_delta>assistant: latest</transcript_delta><input>latest</input>"))?.transcript,
    [{ role: "assistant", text: "latest" }, { role: "user", text: "latest" }]);
  assert.deepEqual(parseRealtimeDelegation(envelope("<transcript_delta>user:\nassistant:</transcript_delta><input></input>"))?.transcript,
    [{ role: "user", text: "" }]);
  for (const separator of ["\r", "\u2028", "\u2029"]) {
    assert.deepEqual(parseRealtimeDelegation(envelope(`<transcript_delta>assistant: a${separator}user: b</transcript_delta><input>x</input>`))?.transcript,
      [{ role: "user", text: "x" }]);
  }
});

test("realtime handoff identifiers strip the exact prefix only", () => {
  assert.equal(realtimeDelegationHandoffId("realtime-delegation-leading"), "leading");
  assert.equal(realtimeDelegationHandoffId("realtime-delegation-"), "");
  assert.equal(realtimeDelegationHandoffId("realtime-delegation-next"), "next");
  assert.equal(realtimeDelegationHandoffId("xrealtime-delegation-next"), null);
});


test("legacy voice envelopes keep case-insensitive inner tags and typed timeline projection", () => {
  const markup = envelope("<SoUrCe>transcript_tail_flush</SoUrCe><TrAnScRiPt_DeLtA>assistant: Ready</TrAnScRiPt_DeLtA><InPuT>Hello voice</InPuT>");
  assert.deepEqual(parseRealtimeDelegation(markup), { input: "Hello voice", source: "transcript_tail_flush", transcriptDelta: "assistant: Ready", transcript: [{ role: "assistant", text: "Ready" }, { role: "user", text: "Hello voice" }] });
  for (const type of ["userMessage", "steeringUserMessage"]) {
    const snapshot = projectTimeline({ key: createConversationKey("fixture", "legacy-voice"), revision: 1, phase: "live", authoritative: true,
      turns: [{ id: "turn", status: "complete", items: [{ id: "realtime-delegation-legacy", type, payload: { content: [{ type: "text", text: markup }], input: [{ type: "text", text: markup }] } }] }],
    }, createDefaultTimelineProjectorRegistry());
    const blocks = snapshot.frames.flatMap(frame => frame.blocks);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.type, "realtime-transcript");
    if (blocks[0]?.type !== "realtime-transcript") throw new Error("Expected a typed legacy transcript");
    assert.deepEqual(blocks[0].entries, [{ role: "assistant", text: "Ready" }, { role: "user", text: "Hello voice" }]);
    assert.equal(blocks[0].handoffId, "legacy");
  }
});

test("voice role markers do not absorb repeated bare line separators", () => {
  for (const separator of ["\r\r", "\u2028\u2028", "\u2029\u2029", "\r\u2028"]) {
    assert.deepEqual(parseRealtimeDelegation(envelope(`<transcript_delta>assistant:${separator}user: next</transcript_delta><input>latest</input>`))?.transcript, [{ role: "user", text: "latest" }]);
  }
  assert.deepEqual(parseRealtimeDelegation(envelope("<transcript_delta>assistant:\rReady</transcript_delta><input>latest</input>"))?.transcript, [{ role: "assistant", text: "Ready" }, { role: "user", text: "latest" }]);
  assert.deepEqual(parseRealtimeDelegation(envelope("<transcript_delta>assistant:   Ready\ncontinuation</transcript_delta><input>latest</input>"))?.transcript, [{ role: "assistant", text: "Ready\ncontinuation" }, { role: "user", text: "latest" }]);
});



test("singleton typed voice input projects a transcript instead of raw handoff markup", () => {
  const markup = envelope("<transcript_delta>assistant: Ready</transcript_delta><input>Hello voice</input>");
  const part = { type: "text", text: markup };
  assert.equal(realtimeDelegationText(part), markup);
  assert.deepEqual(parseRealtimeDelegation(part), parseRealtimeDelegation([part]));
  for (const type of ["userMessage", "steeringUserMessage"]) {
    const snapshot = projectTimeline({ key: createConversationKey("fixture", "singleton-voice"), revision: 1, phase: "live", authoritative: true,
      turns: [{ id: "turn", status: "complete", items: [{ id: "realtime-delegation-fixture", type, payload: { input: part, content: part } }] }],
    }, createDefaultTimelineProjectorRegistry());
    const blocks = snapshot.frames.flatMap(frame => frame.blocks);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.type, "realtime-transcript");
    if (blocks[0]?.type !== "realtime-transcript") throw new Error("Expected a typed transcript");
    assert.deepEqual(blocks[0].entries, [{ role: "assistant", text: "Ready" }, { role: "user", text: "Hello voice" }]);
    assert.equal(blocks[0].handoffId, "fixture");
  }
});
