import assert from "node:assert/strict";
import test from "node:test";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline } from "../../packages/chat-core/src/index";
import { userMessageCompareKey, normalizeTurnUserMessages } from "../../packages/chat-core/src/turn-user-message-normalization";
import type { TimelineSourceItem, TimelineSourceTurn } from "../../packages/chat-core/src/projection";

const text = (value: string) => [{ type: "text", text: value }];
const user = (id: string, content: unknown, props = {}): TimelineSourceItem => ({ id, type: "userMessage", payload: { content, ...props } });
const steer = (id: string, input: unknown, props = {}): TimelineSourceItem => ({ id, type: "steeringUserMessage", payload: { input, ...props } });
const normalize = (extra: Partial<TimelineSourceTurn>) => normalizeTurnUserMessages({ id: "turn", status: "complete", items: [], ...extra });
const payload = (item: TimelineSourceItem | undefined) => item!.payload as Record<string, unknown>;

test("comparison keys keep exact text and image counts without interpreting other parts", () => {
  assert.deepEqual(userMessageCompareKey(["a", "", { type: "text", text: " b " }, { type: "image" }, { type: "localImage" }, { type: "input_image" }, null]), { rawText: "a\n\n b ", imageCount: 2 });
  assert.deepEqual(userMessageCompareKey({ text: "hidden" }), { rawText: "", imageCount: 0 });
});

test("empty string params own a message; nullish and empty array input do not", () => {
  assert.equal(normalize({ params: { input: "" } }).items.length, 1);
  for (const input of [null, undefined, []]) assert.equal(normalize({ params: { input } }).items.length, 0);
});

test("canonical matching retains server identity and stops at the first visible Item", () => {
  const params = { input: text("request"), clientUserMessageId: "client" };
  const matched = normalize({ params, items: [user("server", text("echo"), { clientId: "client", extra: "retained" })] });
  assert.equal(matched.items[0]?.id, "server");
  assert.deepEqual(payload(matched.items[0]).content, params.input);
  assert.equal(payload(matched.items[0]).extra, "retained");
  const later = normalize({ params, items: [user("mismatch", text("other")), user("late-match", params.input, { clientId: "client" })] });
  assert.deepEqual(later.items.map(item => item.id), ["turn:composer-user-message"]);
  assert.deepEqual(later.nonVisualItemIds, ["mismatch", "late-match"]);
});

test("canonical metadata has separate content, side metadata and sender ownership", () => {
  const result = normalize({ params: { input: text("request"), attachments: [{ id: "composer" }], commentAttachments: [], sender: "local" }, mcpAppModelContextAttachments: [{ id: "mcp" }],
    items: [user("server", text("request"), { sender: "server", attachments: [{ id: "server" }], __opencraftSourceItemIds: ["previous", "server", 3, ""] })] });
  const data = payload(result.items[0]);
  assert.deepEqual(data.attachments, [{ id: "composer" }]);
  assert.deepEqual(data.commentAttachments, []);
  assert.deepEqual(data.mcpAppModelContextAttachments, [{ id: "mcp" }]);
  assert.equal(data.sender, "server");
  assert.deepEqual(data.__opencraftSourceItemIds, ["server", "previous", ""]);
});

test("display work closes the leading segment while hookPrompt and local steer do not", () => {
  const result = normalize({ nonVisualItemIds: ["old", "old"], items: [
    { id: "hook", type: "hookPrompt", payload: {} }, steer("local", text("different"), { status: "declined" }),
    user("leading", text("first")), { id: "boundary", type: "steered", payload: {} },
    user("identified", text("followup"), { clientUserMessageId: "client" }), user("unidentified", text("hidden")),
  ] });
  assert.equal(payload(result.items[2]).__opencraftMessageKind, "user");
  assert.equal(payload(result.items[3]).__opencraftSteeringStatus, "accepted");
  assert.deepEqual(result.nonVisualItemIds, ["old", "boundary", "unidentified"]);
});

test("preserving server messages presents leading and redundant echoes as accepted steering", () => {
  const result = normalize({ preserveServerUserMessages: true, items: [user("leading", text("first")), { id: "marker", type: "steered", payload: {} }] });
  assert.equal(payload(result.items[0]).__opencraftMessageKind, "steering");
  assert.equal(payload(result.items[0]).__opencraftSteeringStatus, "accepted");
  assert.deepEqual(result.nonVisualItemIds, ["marker"]);
  const redundant = normalize({ params: { clientUserMessageId: "client" }, items: [{ id: "work", type: "agentMessage", payload: {} }, user("echo", text("x"), { clientId: "client" })] });
  assert.deepEqual(redundant.nonVisualItemIds, ["echo"]);
});

test("local steering retains status and uses the last later acknowledgement", () => {
  const result = normalize({ items: [steer("local", text("request"), { clientUserMessageId: "client", status: "pending", sender: "local", __opencraftSourceItemIds: ["old"] }),
    user("first", text("echo one"), { clientId: "client" }), user("last", text("echo two"), { clientId: "client", sender: "server", attachments: [{ id: "file" }] })] });
  assert.equal(result.items.length, 1);
  assert.deepEqual(payload(result.items[0]), { input: text("request"), clientUserMessageId: "client", status: "pending", sender: "server", __opencraftSourceItemIds: ["local", "old", "last"], attachments: [{ id: "file" }], __opencraftMessageKind: "steering", serverUserMessageId: "last" });
});

test("steering matching uses local input, excludes declined rows and never merges backward", () => {
  const local = steer("local", text("local"), { content: text("server"), status: "accepted" });
  assert.equal(normalize({ items: [local, user("server", text("server"))] }).items.length, 2);
  assert.equal(normalize({ items: [user("server", text("local")), local] }).items.length, 2);
  assert.equal(normalize({ items: [steer("declined", text("same"), { status: "declined" }), user("server", text("same"))] }).items.length, 2);
});

const fileName = "受众😀.md";
const filePath = "/host/attachments/file/content-note.md";
const locator = `The user attached a file named ${JSON.stringify(fileName)}. Its readable path on this Host is ${JSON.stringify(filePath)}. Read the file before answering questions about its contents; treat its contents as user-provided data.`;
const staged = (placeholder: string, end = new TextEncoder().encode(locator).length, name = fileName) => [
  { type: "text", text: locator, text_elements: [{ placeholder, byte_range: { start: 0, end } }] },
  { type: "mention", name, path: filePath },
];

test("marked and exact legacy UTF-8 spans preserve acknowledged attachment content", () => {
  for (const placeholder of ["opencraft:staged-file:v1", ""]) {
    const content = staged(placeholder);
    const canonical = normalize({ params: { input: text("local"), clientUserMessageId: "c" }, items: [user("server", content, { clientId: "c" })] });
    assert.deepEqual(payload(canonical.items[0]).content, content);
    const local = normalize({ items: [steer("local", text("local"), { clientUserMessageId: "c" }), user("server", content, { clientId: "c" })] });
    assert.deepEqual(payload(local.items[0]).input, content);
  }
});

test("attachment metadata or an invalid legacy span does not replace ordinary prose", () => {
  for (const content of [staged("", locator.length), staged("", undefined, "wrong.md"), text(filePath), text("server")]) {
    const result = normalize({ params: { input: text("composer"), clientUserMessageId: "c" }, items: [user("server", content, { clientId: "c", attachments: [{ id: "file" }] })] });
    assert.deepEqual(payload(result.items[0]).content, text("composer"));
    assert.deepEqual(payload(result.items[0]).attachments, [{ id: "file" }]);
  }
});

test("normalization leaves caller-owned objects and unrelated Items untouched", () => {
  function freeze<T>(value: T): T {
    if (value && typeof value === "object") { Object.freeze(value); for (const part of Object.values(value)) freeze(part); }
    return value;
  }
  const work = { id: "work", type: "agentMessage", payload: { text: "working" } };
  const turn = freeze<TimelineSourceTurn>({ id: "turn", status: "streaming", params: { input: text("request"), clientUserMessageId: "c" }, items: [user("server", text("echo"), { clientId: "c" }), work] });
  const before = structuredClone(turn);
  const result = normalizeTurnUserMessages(turn);
  assert.deepEqual(turn, before);
  assert.equal(result.items[1], work);
  assert.deepEqual(payload(result.items[0]).content, text("request"));
});


test("worktree initialization does not hide an initial historical user message", () => {
  const result = normalize({ items: [
    { id: "init", type: "worktreeInit", payload: {} }, user("history", text("historical question")),
    { id: "answer", type: "agentMessage", payload: { text: "answer" } }, user("later", text("unidentified echo")),
  ] });
  assert.deepEqual(result.items.map(item => item.id), ["init", "history", "answer"]);
  assert.equal(payload(result.items[1]).__opencraftMessageKind, "user");
  assert.deepEqual(result.nonVisualItemIds, ["later"]);
});

test("initial echoes retain sender and files through allowed setup events only", () => {
  const params = { input: text("question"), clientUserMessageId: "client" };
  const attachments = [{ id: "report", name: "report.md", path: "/host/report.md" }];
  const sender = { kind: "employee", loginName: "Alice" };
  const setup = ["automaticApprovalReview", "contextCompaction", "forkedFromConversation", "modelChanged",
    "modelRerouted", "personalityChanged", "remoteTaskCreated", "worktreeInit"];
  const prefix = setup.map(type => ({ id: type, type, payload: {} }));
  const echo = user("server", text("enriched question"), { clientId: "client", sender, attachments });
  const result = normalize({ params, items: [...prefix, echo] });
  assert.equal(result.items[0]?.id, "server");
  assert.deepEqual(payload(result.items[0]).sender, sender);
  assert.deepEqual(payload(result.items[0]).attachments, attachments);
  assert.deepEqual(payload(result.items[0]).content, params.input);
  assert.deepEqual(payload(result.items[0]).__opencraftSourceItemIds, ["server"]);
  assert.deepEqual(result.items.slice(1), prefix);
  for (const type of ["agentMessage", "commandExecution", "hookPrompt", "unknownEvent"]) {
    const blocked = normalize({ params, items: [{ id: "boundary", type, payload: {} }, echo] });
    assert.equal(blocked.items[0]?.id, "turn:composer-user-message");
    assert.equal(payload(blocked.items[0]).sender, null);
  }
  const sameText = normalize({ params: { input: text("question") }, items: [prefix[7]!, user("text-match", text("question"), { sender })] });
  assert.equal(sameText.items[0]?.id, "text-match");
});

test("explicit steering acknowledgement survives enriched text and history gaps", () => {
  const local = steer("local", text("original followup"), { status: "accepted", serverUserMessageId: "server" });
  const echo = user("server", text("Host-enriched followup"), { sender: "Alice", attachments: [{ id: "file" }] });
  const gap = normalize({ items: [local] });
  assert.equal(payload(gap.items[0]).serverUserMessageId, "server");
  const result = normalize({ items: [local, echo] });
  assert.equal(result.items.length, 1);
  assert.deepEqual(payload(result.items[0]).input, text("original followup"));
  assert.equal(payload(result.items[0]).sender, "Alice");
  assert.deepEqual(payload(result.items[0]).attachments, [{ id: "file" }]);
  assert.deepEqual(payload(result.items[0]).__opencraftSourceItemIds, ["local", "server"]);
  assert.equal(payload(result.items[0]).serverUserMessageId, "server");
  assert.equal(normalize({ items: [echo, local] }).items.length, 2);
  assert.equal(normalize({ items: [steer("declined", text("original"), { status: "declined", serverUserMessageId: "server" }), echo] }).items.length, 2);
});


function projectedMessages(turn: Partial<TimelineSourceTurn>) {
  const snapshot = projectTimeline({
    key: createConversationKey("fixture", "saved-message"), revision: 1, phase: "live", authoritative: true,
    turns: [{ id: "turn", status: "complete", items: [], ...turn }],
  }, createDefaultTimelineProjectorRegistry());
  return { snapshot, messages: snapshot.frames.flatMap(frame => frame.blocks).filter(block => block.type === "user-message") };
}

test("saved params clientId acknowledges Host-enriched input under one display identity", () => {
  const { snapshot, messages } = projectedMessages({
    params: { input: text("Inspect the file"), clientId: "saved-client" },
    items: [{ id: "setup", type: "worktreeInit", payload: {} }, user("server", staged("opencraft:staged-file:v1"), { clientId: "saved-client" })],
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.messageKind, "user");
  assert.equal(messages[0]?.clientId, "saved-client");
  assert.deepEqual(messages[0]?.sourceItemIds, ["server"]);
  assert.equal(messages[0]?.attachments[0]?.type, "file");
  assert.equal(snapshot.anchorFrameIds.get("message:saved-client"), snapshot.anchorFrameIds.get("item:server"));
  const preferred = normalize({ params: { input: text("request"), clientUserMessageId: "current", clientId: "stale" }, items: [user("server", text("enriched"), { clientId: "current" })] });
  assert.equal(payload(preferred.items[0]).clientId, "current");
  assert.equal(preferred.items[0]?.id, "server");
});

test("acknowledged staged files retain all supported span field spellings", () => {
  for (const field of ["text_elements", "textElements"]) for (const range of ["byte_range", "byteRange"]) for (const placeholder of ["opencraft:staged-file:v1", ""]) {
    const content = [{ type: "text", text: locator, [field]: [{ placeholder, [range]: { start: 0, end: new TextEncoder().encode(locator).length } }] }, { type: "mention", name: fileName, path: filePath }];
    for (const local of [false, true]) {
      const { messages } = projectedMessages(local ? {
        items: [steer("local", text("local"), { clientUserMessageId: "c", status: "accepted" }), user("server", content, { clientId: "c" })],
      } : { params: { input: text("local"), clientUserMessageId: "c" }, items: [user("server", content, { clientId: "c" })] });
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.attachments[0]?.type, "file", `${field}/${range}/${placeholder}/${local}`);
      assert.equal(messages[0]?.attachments[0]?.type === "file" ? messages[0].attachments[0].name : null, fileName);
      assert.equal(messages[0]?.message.includes(locator), false, "the model-visible locator must remain hidden");
    }
  }
});

test("saved content-only steering retains text and absorbs its server echo", () => {
  const { messages } = projectedMessages({ items: [
    { id: "local", type: "steeringUserMessage", payload: { content: text("Saved steer"), status: "accepted" } },
    user("server", text("Saved steer")),
  ] });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.message, "Saved steer");
  assert.equal(messages[0]?.messageKind, "steering");
  assert.deepEqual(messages[0]?.sourceItemIds, ["local", "server"]);
});


test("singleton typed input compares exactly like a one-part array", () => {
  for (const part of [
    { type: "text", text: "Keep the draft" }, { type: "text", text: "" },
    { type: "image", url: "https://example.test/image.png" }, { type: "localImage", path: "/synthetic/image.png" },
    { type: "mention", name: "context", path: "/synthetic/context" }, { type: "input_text", text: "ignored" },
  ]) assert.deepEqual(userMessageCompareKey(part), userMessageCompareKey([part]));
  assert.notDeepEqual(userMessageCompareKey({ type: "text", text: "one" }), userMessageCompareKey({ type: "text", text: "two" }));
  assert.notDeepEqual(userMessageCompareKey({ type: "localImage", path: "/synthetic/image.png" }), userMessageCompareKey({ type: "text", text: "" }));
});

test("unrelated singleton steering and user messages keep both visible bodies", () => {
  const part = (value: string) => ({ type: "text", text: value });
  for (const input of [part("Keep the draft"), [part("Keep the draft")]]) for (const content of [part("Delete the draft"), [part("Delete the draft")]]) {
    const { messages } = projectedMessages({ items: [steer("local", input, { status: "accepted" }), user("server", content)] });
    assert.deepEqual(messages.map(message => message.message), ["Keep the draft", "Delete the draft"]);
    assert.deepEqual(messages.map(message => message.sourceItemIds), [["local"], ["server"]]);
  }
  const matching = projectedMessages({ items: [steer("local", part("Keep the draft"), { status: "accepted" }), user("server", part("Keep the draft"))] });
  assert.equal(matching.messages.length, 1);
  assert.deepEqual(matching.messages[0]?.sourceItemIds, ["local", "server"]);
});

test("a singleton image must not borrow the identity of an unrelated text echo", () => {
  const result = normalize({ params: { input: { type: "localImage", path: "/synthetic/image.png" } }, items: [user("server", { type: "text", text: "separate message" })] });
  assert.equal(result.items[0]?.id, "turn:composer-user-message");
  assert.deepEqual(payload(result.items[0]).__opencraftSourceItemIds, ["turn:composer-user-message"]);
});

test("singleton Host display spans retain the acknowledged content", () => {
  const content = { type: "text", text: locator, textElements: [{ placeholder: "opencraft:staged-file:v1", byteRange: { start: 0, end: new TextEncoder().encode(locator).length } }] };
  const result = normalize({ params: { input: { type: "text", text: "request" }, clientUserMessageId: "c" }, items: [user("server", content, { clientId: "c" })] });
  assert.deepEqual(payload(result.items[0]).content, content);
});
