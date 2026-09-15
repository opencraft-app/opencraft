import assert from "node:assert/strict";
import test from "node:test";

import { ThreadTitleService } from "../src/services/thread-title.ts";

function fixture(name = "☁️ ✅ 我 · Existing title") {
  const thread = { id: "thread-1", name, preview: "", ephemeral: false };
  const service = Object.create(ThreadTitleService.prototype);
  service.records = new Map();
  service.listeners = new Set();
  service.persist = () => {};
  service.ctx = {
    threadManager: {
      get: (threadId) => {
        assert.equal(threadId, thread.id);
        return thread;
      },
      changed: () => {},
    },
  };
  return { service, thread };
}

test("structured titles separate shared text from platform presentation", () => {
  const { service, thread } = fixture();
  const initial = service.ensure(thread, thread.name, { now: 100, source: "migration" });
  assert.deepEqual(initial, {
    threadId: "thread-1",
    text: "Existing title",
    revision: 1,
    updatedBy: null,
    updatedByUsername: null,
    updatedAtMs: 100,
    source: "migration",
    sourceThreadId: null,
  });
  assert.equal(thread.name, "☁️ Existing title");

  let changed;
  service.onChange((event) => { changed = event; });
  const renamed = service.set("thread-1", "☁️ 🔒 我 · Team title", {
    expectedRevision: 1,
    actor: { id: "user:alice", username: "alice" },
    now: 200,
  });
  assert.equal(renamed.text, "Team title");
  assert.equal(renamed.revision, 2);
  assert.equal(renamed.updatedBy, "user:alice");
  assert.equal(renamed.updatedByUsername, "alice");
  assert.equal(thread.name, "☁️ Team title");
  assert.equal(changed.record.text, "Team title");

  assert.throws(
    () => service.set("thread-1", "Stale writer", { expectedRevision: 1 }),
    (error) => error.code === -32072 && error.data.current.revision === 2,
  );
});

test("forked titles copy text into an independent revision history", () => {
  const source = { id: "source", name: "☁️ Source title", preview: "" };
  const destination = { id: "fork", name: "☁️ ✅ 我 · Source title", preview: "" };
  const threads = new Map([[source.id, source], [destination.id, destination]]);
  const service = Object.create(ThreadTitleService.prototype);
  service.records = new Map();
  service.listeners = new Set();
  service.persist = () => {};
  service.ctx = { threadManager: { get: (id) => threads.get(id) } };
  service.ensure(source, source.name, { now: 100 });

  const inherited = service.inherit(source.id, destination.id, {
    actor: { id: "user:bob", username: "bob" },
    now: 300,
  });
  assert.equal(inherited.text, "Source title");
  assert.equal(inherited.revision, 1);
  assert.equal(inherited.sourceThreadId, "source");
  assert.equal(inherited.updatedByUsername, "bob");
  assert.equal(destination.name, "☁️ Source title");
});

test("a successful rename response attributes an earlier backend notification", () => {
  const { service, thread } = fixture("☁️ Old title");
  service.ensure(thread, thread.name, { now: 100 });

  const backend = service.set(thread.id, "New title", { source: "backend", now: 200 });
  assert.equal(backend.revision, 2);
  assert.equal(backend.updatedBy, null);

  const user = service.set(thread.id, "New title", {
    source: "user",
    actor: { id: "user:alice", username: "alice" },
    attributeIfSame: true,
    now: 210,
  });
  assert.equal(user.revision, 2);
  assert.equal(user.updatedBy, "user:alice");
  assert.equal(user.updatedByUsername, "alice");
  assert.equal(user.source, "user");
});
