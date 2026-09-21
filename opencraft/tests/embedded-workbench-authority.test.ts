import assert from "node:assert/strict";
import test from "node:test";

import { EmbeddedChatWriteAuthority } from "../apps/workbench-web/src/embedded-chat/embedded-chat-authority";

test("Embedded Chat remains read-only until the host grants its write lease", () => {
  const authority = new EmbeddedChatWriteAuthority();
  const observed: boolean[] = [];
  const stop = authority.subscribe(() => observed.push(authority.getSnapshot().writable));

  assert.equal(authority.getSnapshot().writable, false);
  authority.setWritable(false);
  authority.setWritable(true);
  authority.setWritable(true);
  authority.setWritable(false);

  assert.deepEqual(observed, [true, false]);
  stop();
});
