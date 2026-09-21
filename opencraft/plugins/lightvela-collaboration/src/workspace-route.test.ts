import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCollaborationWorkspaceRoute,
  serializeCollaborationWorkspaceRoute,
  type CollaborationWorkspaceRoute,
} from "./workspace-route";

test("Collaboration Workspace resource routes round-trip stable business identities", () => {
  const routes: CollaborationWorkspaceRoute[] = [
    { kind: "home" },
    { kind: "chat", serverId: "server-1" },
    { kind: "channel", serverId: "server-1", channelId: "channel-1" },
    { kind: "direct", serverId: "server-1", directConversationId: "direct-1" },
    { kind: "member", serverId: "server-1", memberId: "member-1" },
    {
      kind: "im-thread",
      serverId: "server-1",
      channelId: "channel-1",
      threadId: "thread-1",
    },
    { kind: "computers", serverId: "server-1" },
    { kind: "computer", serverId: "server-1", computerId: "computer-1" },
  ];

  for (const route of routes) {
    const serialized = serializeCollaborationWorkspaceRoute(route);
    assert.deepEqual(parseCollaborationWorkspaceRoute(serialized), route);
  }
});

test("Collaboration Workspace rejects foreign, malformed and incomplete resource routes", () => {
  assert.equal(parseCollaborationWorkspaceRoute(null), null);
  assert.equal(parseCollaborationWorkspaceRoute("https://example.test/servers/server-1"), null);
  assert.equal(
    parseCollaborationWorkspaceRoute("lightvela-collaboration://servers/server-1/chat/channels"),
    null,
  );
  assert.equal(
    parseCollaborationWorkspaceRoute("lightvela-collaboration://servers/%2F/chat"),
    null,
  );
});
