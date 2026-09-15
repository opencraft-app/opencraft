import assert from "node:assert/strict";
import test from "node:test";

import type {
  Channel,
  ConversationAddress,
  DirectConversationResource,
  Member,
} from "@lightvela/vela-chat-client-core";
import { CollaborationWorkspaceController } from "./collaboration-workspace-controller";

const channel = {
  id: "channel-1",
  serverId: "server-1",
  joined: true,
  imState: "ready",
  imGroupId: "community-1",
  imTopicId: "topic-1",
} as Channel;
const direct = {
  id: "direct-1",
  imGroupId: "private-group-1",
  imState: "ready",
} as DirectConversationResource;

test("Workspace controller opens IM resources but keeps member and Computer routes out of Chat state", async () => {
  const directoryLoads: string[] = [];
  const opened: ConversationAddress[] = [];
  let workspaceLoads = 0;
	const computerLoads: string[] = [];
  const controller = new CollaborationWorkspaceController(
	{
	  load: async () => { workspaceLoads += 1; },
	  loadComputers: async (serverId) => { computerLoads.push(serverId); },
	},
    {
      load: async (serverId) => { directoryLoads.push(serverId); },
      getSnapshot: () => ({
        phase: "ready",
        serverId: "server-1",
        channels: [channel],
        directConversations: [direct],
        members: [] as Member[],
        error: null,
        revision: 1,
      }),
    },
	{ open: async (address) => { opened.push(address); } },
	true,
  );

  await controller.activate({ kind: "channel", serverId: "server-1", channelId: "channel-1" });
  await controller.activate({ kind: "direct", serverId: "server-1", directConversationId: "direct-1" });
  await controller.activate({ kind: "member", serverId: "server-1", memberId: "member-1" });
  await controller.activate({ kind: "computer", serverId: "server-1", computerId: "computer-1" });

  assert.equal(workspaceLoads, 4);
	assert.deepEqual(computerLoads, ["server-1"]);
  assert.deepEqual(directoryLoads, ["server-1", "server-1", "server-1"]);
  assert.deepEqual(opened, [
    {
      channelId: "channel-1",
      conversationId: "GROUPtopic-1",
      imGroupId: "community-1",
      imTopicId: "topic-1",
      targetId: "topic-1",
    },
    {
      conversationId: "GROUPprivate-group-1",
      directConversationId: "direct-1",
      imGroupId: "private-group-1",
      targetId: "private-group-1",
    },
  ]);
});
