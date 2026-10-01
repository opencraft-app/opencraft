import assert from "node:assert/strict";
import test from "node:test";

import type { SubmitIntent } from "@opencraft/composer-core";
import { asHostId, asThreadId } from "@opencraft/chat-core";
import { isStandaloneHermesStop } from "../apps/workbench-web/src/hermes-stop-command";

const baseIntent: SubmitIntent = {
  commandId: "command",
  clientMessageId: "message",
  target: { type: "existing-thread", key: { hostId: asHostId("hermes"), threadId: asThreadId("thread") } },
  document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "/stop " }] }] },
  attachments: [],
  context: [],
  selections: {},
  options: { autoContext: false },
  createdAt: 0,
};

test("Hermes Stop recognizes only a standalone command without other input", () => {
  assert.equal(isStandaloneHermesStop(baseIntent), true);
  assert.equal(isStandaloneHermesStop({
    ...baseIntent,
    document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "command", name: "stop" }] }] },
  }), true);
  assert.equal(isStandaloneHermesStop({
    ...baseIntent,
    document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "/stop please" }] }] },
  }), false);
  assert.equal(isStandaloneHermesStop({
    ...baseIntent,
    document: { version: 1, blocks: [{ type: "code-block", text: "/stop" }] },
  }), false);
  assert.equal(isStandaloneHermesStop({
    ...baseIntent,
    attachments: [{ id: "image", name: "image.png", mimeType: "image/png", size: 1, uri: "file://image", lifecycle: "ready", error: null }],
  }), false);
  assert.equal(isStandaloneHermesStop({ ...baseIntent, context: [{ id: "file", kind: "file", title: "file", uri: "file://example", visible: true }] }), false);
});
