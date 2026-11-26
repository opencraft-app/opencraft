import assert from "node:assert/strict";
import test from "node:test";

import { projectEmbeddedSession } from "../../apps/workbench-web/src/embedded-chat/embedded-session-projection";

const thread = { id: "t1", title: "Example", status: "running", pinned: true };
const catalogThread = { updatedAt: 123, extra: { source: "schedule", providerPrivate: "internal" } };

test("the default embedded session shape omits catalog provider metadata", () => {
  assert.deepEqual(projectEmbeddedSession(thread, catalogThread), {
    chatId: "t1",
    title: "Example",
    createdAt: 123,
    updatedAt: 123,
    readOnly: false,
    running: true,
    pinned: true,
  });
});

test("trusted embeds publish only the values returned by their projector", () => {
  const session = projectEmbeddedSession(thread, catalogThread, (metadata) => {
    assert.equal(metadata, catalogThread.extra);
    return { source: catalogThread.extra.source };
  });
  assert.deepEqual(session.extra, { source: "schedule" });
  assert.equal(session.chatId, "t1");
});

test("absent or declined metadata is omitted from the published row", () => {
  const unexpectedProjector = () => assert.fail("missing metadata should not reach the projector");
  assert.equal(Object.hasOwn(projectEmbeddedSession(thread, undefined, unexpectedProjector), "extra"), false);
  assert.equal(
    Object.hasOwn(projectEmbeddedSession(thread, { updatedAt: 123, extra: null }, unexpectedProjector), "extra"),
    false,
  );
  assert.equal(
    Object.hasOwn(
      projectEmbeddedSession(thread, catalogThread, () => undefined),
      "extra",
    ),
    false,
  );
});
