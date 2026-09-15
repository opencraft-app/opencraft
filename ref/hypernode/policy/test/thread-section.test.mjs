import assert from "node:assert/strict";
import test from "node:test";

import {
  PINNED_THREAD_SECTION,
  PINNED_THREAD_SECTION_ID,
  ThreadSectionService,
} from "../src/services/thread-section.ts";

function sectionService() {
  const moves = [];
  const service = Object.create(ThreadSectionService.prototype);
  service.principal = { id: "node:root" };
  service.sections = new Map([[PINNED_THREAD_SECTION_ID, { ...PINNED_THREAD_SECTION }]]);
  service.ctx = {
    threadManager: {
      moveToSection: (...args) => moves.push(args),
      clearSection: () => {},
      threads: new Map(),
      persist: () => {},
    },
  };
  service.persist = () => {};
  return { service, moves };
}

test("the built-in pinned section follows the official stable identity", () => {
  const { service } = sectionService();
  assert.deepEqual(service.list(), { data: [{ ...PINNED_THREAD_SECTION }], nextCursor: null });
});

test("thread/section/move resolves membership before changing a thread", () => {
  const { service, moves } = sectionService();
  service.move({ threadId: "thread-1", sectionId: PINNED_THREAD_SECTION_ID, beforeThreadId: null });
  assert.deepEqual(moves, [["thread-1", { ...PINNED_THREAD_SECTION }, null]]);
  assert.throws(
    () => service.move({ threadId: "thread-1", sectionId: "missing", beforeThreadId: null }),
    /does not exist/,
  );
});

test("custom thread sections support create, update, pagination, and delete", () => {
  const { service } = sectionService();
  const previousRandomBytes = globalThis.crypto.randomBytes;
  globalThis.crypto.randomBytes = () => "0123456789abcdef0123";
  try {
    const created = service.create({ name: " Project A ", appearance: { icon: "folder", color: "blue" } });
    assert.equal(created.name, "Project A");
    assert.deepEqual(created.appearance, { icon: "folder", color: "blue" });

    const updated = service.update({ sectionId: created.id, name: "Project B", appearance: null });
    assert.equal(updated.name, "Project B");
    assert.equal(updated.appearance, null);
    assert.equal(service.list({ limit: 1 }).nextCursor, PINNED_THREAD_SECTION_ID);
    assert.deepEqual(service.delete({ sectionId: created.id }), {});
    assert.throws(() => service.get(created.id), /does not exist/);
  } finally {
    if (previousRandomBytes === undefined) delete globalThis.crypto.randomBytes;
    else globalThis.crypto.randomBytes = previousRandomBytes;
  }
});
