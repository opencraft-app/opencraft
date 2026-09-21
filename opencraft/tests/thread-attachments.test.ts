import assert from "node:assert/strict";
import test from "node:test";
import { ThreadAttachments } from "../apps/local-agent-host/src/thread-attachments.js";
test("unsubscribe belongs to the logical client, not the shared physical connection", () => {
  const attachments = new ThreadAttachments();
  attachments.attach("window-a", "thread"); attachments.attach("window-b", "thread");
  assert.equal(attachments.detach("window-a", "thread"), "unsubscribed");
  assert.equal(attachments.has("window-b", "thread"), true);
  assert.equal(attachments.count("thread"), 1);
  assert.equal(attachments.detach("window-a", "thread"), "notSubscribed");
  assert.equal(attachments.detach("window-a", "missing"), "notLoaded");
  const version = attachments.version("thread");
  attachments.attach("window-a", "thread"); assert.notEqual(attachments.version("thread"), version);
});
