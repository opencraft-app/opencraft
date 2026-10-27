import assert from "node:assert/strict";
import test from "node:test";

import { createConversationReturnProbe } from "@opencraft/workbench-runtime";

test("short interruptions preserve the current conversation without a probe", () => {
  const probe = createConversationReturnProbe();
  probe.background(1_000);
  assert.equal(probe.foreground(3_000), false);
  assert.equal(probe.foreground(30_000), false);
});

test("foreground and network recovery are coalesced by a shared cooldown", () => {
  const probe = createConversationReturnProbe();
  probe.background(1_000);
  assert.equal(probe.foreground(17_000), true);
  probe.offline();
  assert.equal(probe.online(18_000), false);
  probe.offline();
  assert.equal(probe.online(23_000), true);
});
