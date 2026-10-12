import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline } from "@opencraft/chat-core";
import { CodexHostStateDatabase } from "../apps/opencraft-daemon/src/codex-host-state-database";
import { CodexHostQueue } from "../apps/opencraft-daemon/src/codex-host-queue";
import { CodexMessageSenders } from "../apps/opencraft-daemon/src/codex-message-senders";
import { projectCodexMessageNotification, projectCodexMessageResult } from "../apps/opencraft-daemon/src/codex-message-projection";
const a = { kind: "employee" as const, loginName: "employee.a" };
const b = { kind: "employee" as const, loginName: "employee.b" };

test("message authors share queue SQLite, survive reopen, and cannot be reassigned", async () => {
  const root = await mkdtemp(join(tmpdir(), "message-senders-"));
  let host = new CodexHostStateDatabase(root);
  try {
    let senders = new CodexMessageSenders(host.database);
    const queue = new CodexHostQueue(root, host.database);
    host.transaction(() => { senders.record("t", "m", a); queue.add("t", "m", [{ type: "text", text: "hello" }]); });
    senders.record("t", "m", a);
    assert.throws(() => senders.record("t", "m", b), /another sender/);
    assert.deepEqual(senders.get("t", "m"), a);
    senders.record("t", "unknown", null);
    assert.throws(() => senders.record("t", "unknown", a), /another sender/);
    assert.throws(() => host.transaction(() => {
      senders.record("t", "rejected", b); queue.add("t", "rejected", []);
    }), /nonempty/);
    assert.equal(host.database.prepare("SELECT count(*) AS n FROM message_senders WHERE client_message_id='rejected'").get()?.n, 0);
    assert.equal(queue.findByClientId("t", "rejected"), null);
    assert.deepEqual((await readdir(root)).filter(n => n.endsWith('.sqlite')), ["codex-host-queue.sqlite"]);
    queue.close(); host.close(); host = new CodexHostStateDatabase(root);
    senders = new CodexMessageSenders(host.database);
    assert.deepEqual(senders.get("t", "m"), a);
    assert.equal(senders.get("other-thread", "m"), null);
    senders.cloneThread("t", "fork");
    assert.deepEqual(senders.get("fork", "m"), a);
  } finally { host.close(); await rm(root, { recursive: true, force: true }); }
});

test("live, paged and resumed messages preserve individual authors within one Turn", () => {
  const authors = new Map([["a", a], ["b", b]]);
  const project = (_thread: string, id: string, value: Record<string, unknown>) => ({ ...value, sender: authors.get(id) ?? null });
  const items = ["a", "b"].map(clientId => ({ type: "userMessage", clientId, content: [] }));
  const live = projectCodexMessageNotification(project, { method: "item/completed", params: { threadId: "t", item: items[1] } }) as any;
  assert.deepEqual(live.params.item.sender, b);
  const turn = { id: "turn", params: { clientUserMessageId: "a", input: [] }, items };
  const page = projectCodexMessageResult(project, "thread/turns/list", { threadId: "t" }, { data: [turn] }) as any;
  assert.deepEqual(page.data[0].items.map((item: any) => item.sender), [a, b]);
  assert.deepEqual(page.data[0].params.sender, a);
  const restored = projectCodexMessageResult(project, "thread/resume", {}, { thread: { id: "t", turns: [turn] } }) as any;
  assert.deepEqual(restored.thread.turns[0].items.map((item: any) => item.sender), [a, b]);
  const itemPage = projectCodexMessageResult(project, "thread/items/list", { threadId: "t" }, { data: [{ item: items[1] }] }) as any;
  assert.deepEqual(itemPage.data[0].item.sender, b);
  const old = projectCodexMessageNotification(project, { params: { threadId: "t", item: { type: "userMessage", id: "old" } } }) as any;
  assert.equal(old.params.item.sender, null);
});


test("shared Chat projection keeps hidden authors without changing visible message text", () => {
  const input = (text: string) => [{ type: "text", text }];
  const projected = projectTimeline({ key: createConversationKey("host", "t"), revision: 1, phase: "live", authoritative: true,
    turns: [{ id: "turn", status: "complete", params: { clientUserMessageId: "a", input: input("hello"), sender: a }, items: [
      { id: "first", type: "userMessage", payload: { clientId: "a", content: input("hello"), sender: a } },
      { id: "steer", type: "steeringUserMessage", payload: { clientId: "b", input: input("follow-up") } },
      { id: "second", type: "userMessage", payload: { clientId: "b", content: input("follow-up"), sender: b } },
    ] }] }, createDefaultTimelineProjectorRegistry());
  const messages = projected.frames.flatMap(frame => frame.blocks).filter(block => block.type === "user-message");
  assert.deepEqual(messages.map(message => message.sender), [a, b]);
  assert.deepEqual(messages.map(message => message.message), ["hello", "follow-up"]);
});
