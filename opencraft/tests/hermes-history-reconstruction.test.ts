import assert from "node:assert/strict";
import test from "node:test";
import { HermesAppServerAdapter } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter";
import type { HermesMessage } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/types";
import { reconcileHistoryWindow } from "../packages/appserver-session/src/merge-turns";

async function harness() {
  const rows: HermesMessage[] = [];
  const requests: Array<{ offset: number; limit: number; order: string; profile?: string | null }> = [];
  const add = (message: HermesMessage) => rows.push({ ...message, id: rows.length + 1 });
  const appendTurn = (name: string, count: number) => {
    add({ role: "user", content: name });
    for (let i = 0; i < count; i++) {
      add({ role: "assistant", content: "Inspect", tool_calls: [{ id: `${name}-${i}`, function: { name: "terminal", arguments: '{"command":"ls src"}' } }] });
      add({ role: "tool", tool_call_id: `${name}-${i}`, content: '{"output":"a","exit_code":0}' });
    }
    add({ role: "assistant", content: "Done" });
  };
  const adapter = new HermesAppServerAdapter({ onEvent() { return () => {}; }, async call<T>(name: string): Promise<T> {
    if (name === "session.resume") return { session_id: "live", stored_session_id: "s", messages: [], running: false } as T;
    if (name === "session.list") return { sessions: [{ id: "s", title: "test", preview: "", profile: "default" }] } as T;
    throw Error(`Unexpected RPC ${name}`);
  } }, "/", {
    async readMessages(sessionId, q) {
      requests.push(q);
      const end = rows.length - q.offset;
      const messages = rows.slice(Math.max(0, end - q.limit), Math.max(0, end));
      return { session_id: sessionId, messages, pagination: { limit: q.limit, offset: q.offset, order: q.order, returned: messages.length } };
    }, dispose() {},
  });
  await adapter.loadThread("s", false, "default");
  return { rows, appendTurn, adapter, requests };
}

test("a 522-row Turn paints one 120-row tail; only explicit backfill reads another page", async t => {
  const h = await harness(); t.after(() => h.adapter.dispose());
  h.appendTurn("older", 2); h.appendTurn("long", 260);
  let page = await h.adapter.readTurnsPage("s", 0, 1, "desc");
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0], { limit: 120, offset: 0, order: "latest", includeCompacted: true, profile: "default" });
  assert.equal(page.nextOffset, 120);
  assert.equal(page.data.length, 1, "partial leading assistant group must be painted, not dropped");
  let painted = page.chronological;
  while (page.nextOffset !== null) {
    const count = h.requests.length;
    page = await h.adapter.readTurnsPage("s", page.nextOffset, 1, "desc");
    assert.equal(h.requests.length, count + 1);
    painted = reconcileHistoryWindow(painted, page.chronological) as typeof painted;
    const ids = painted.flatMap(turn => turn.items.map(item => item.id));
    assert.equal(new Set(ids).size, ids.length, "regrouping must replace the earlier partial projection");
  }
  assert.equal(painted.length, 2);
  assert.equal(painted[1].items.filter(i => i.type === "commandExecution").length, 260);
  const before = structuredClone(painted);
  page = await h.adapter.readTurnsPage("s", 0, 5, "desc");
  assert.deepEqual(reconcileHistoryWindow(painted, page.chronological), before, "tail refresh grafts onto backfilled prefix");
  assert.equal(page.nextOffset, null, "refresh must not reopen fully loaded history");
});

test("Turn limits cannot slice a row window or replace its row cursor", async t => {
  const h = await harness(); t.after(() => h.adapter.dispose());
  for (let index = 0; index < 150; index++) h.appendTurn(`turn-${index}`, 0);
  const tail = await h.adapter.readTurnsPage("s", 0, 1, "desc");
  assert.equal(tail.chronological.length, 60, "all groups in the 120-row tail belong to the history window");
  assert.deepEqual(tail.data, [...tail.chronological].reverse());
  assert.equal(tail.nextOffset, 120);

  const older = await h.adapter.readTurnsPage("s", tail.nextOffset!, 1, "asc");
  assert.deepEqual(h.requests.map(request => request.offset), [0, 120]);
  assert.equal(older.chronological.length, 120);
  assert.deepEqual(older.data, older.chronological);
  assert.deepEqual(older.chronological.slice(-tail.chronological.length), tail.chronological);
  assert.equal(older.nextOffset, 240);

  const complete = await h.adapter.readTurnsPage("s", older.nextOffset!, 1, "desc");
  assert.deepEqual(h.requests.map(request => request.offset), [0, 120, 240]);
  assert.equal(complete.chronological.length, 150);
  assert.equal(complete.nextOffset, null);
  assert.equal(reconcileHistoryWindow(older.chronological, complete.chronological).length, 150);
});

test("backfill owns historical groups, not a concurrently streaming execution", () => {
  const partial = { id: "fragment", items: [], status: "completed", historyWindowId: "scope" };
  const live = { id: "live", items: [{ id: "live-text", type: "agentMessage", text: "newer" }], status: "inProgress" };
  const full = { id: "full", items: [], status: "completed", historyWindowId: "scope" };
  assert.deepEqual(reconcileHistoryWindow([partial, live], [full]), [full, live]);
});
