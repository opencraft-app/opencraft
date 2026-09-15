import assert from "node:assert/strict";
import test from "node:test";

import type {
  Channel,
  DirectConversationResource,
  Member,
  MessagingScope,
} from "@lightvela/vela-chat-client-core";
import { ImDirectoryService } from "./im-directory-service";

const channel = {
  id: "channel-1",
  serverId: "server-1",
  name: "general",
  joined: true,
  imState: "ready",
  imGroupId: "community-1",
  imTopicId: "topic-1",
} as Channel;
const member = {
  id: "member-1",
  serverId: "server-1",
  kind: "human",
  status: "active",
  displayName: "Ada",
  imState: "ready",
  imUserId: "human-1",
} as Member;
const direct = {
  id: "direct-1",
  serverId: "server-1",
  memberA: member,
  memberB: {
    ...member,
    id: "member-2",
    displayName: "Grace",
    imUserId: "human-2",
  },
  status: "active",
  imGroupId: "direct-group-1",
  imState: "ready",
  revision: 1,
} satisfies DirectConversationResource;

test("IM directory loads Channels, private conversations and Members into one Server scope", async () => {
  const scopes: MessagingScope[] = [];
  const service = new ImDirectoryService(
    {
      createDirectConversation: async () => ({ kind: "ready", resource: direct }),
      listChannels: async () => [channel],
      listMembers: async () => [member],
      listDirectConversations: async () => [direct],
    },
    {
      setScope: async (scope) => { scopes.push(scope); },
    },
  );

  await service.load("server-1");

  assert.deepEqual(service.getSnapshot(), {
    phase: "ready",
    serverId: "server-1",
    channels: [channel],
    directConversations: [direct],
    members: [member],
    error: null,
    revision: 2,
  });
  assert.deepEqual(scopes, [{
    generation: 1,
    allowedConversations: [
      {
        channelId: "channel-1",
        conversationId: "GROUPtopic-1",
        imGroupId: "community-1",
        imTopicId: "topic-1",
        targetId: "topic-1",
      },
      {
        conversationId: "GROUPdirect-group-1",
        directConversationId: "direct-1",
        imGroupId: "direct-group-1",
        targetId: "direct-group-1",
      },
    ],
  }]);
});

test("Member selection can create one private IM Group and add it to the shared directory", async () => {
  const scopes: MessagingScope[] = [];
  const service = new ImDirectoryService(
    {
      createDirectConversation: async () => ({ kind: "ready", resource: direct }),
      listChannels: async () => [channel],
      listMembers: async () => [member],
      listDirectConversations: async () => [],
    },
    { setScope: async (scope) => { scopes.push(scope); } },
    { createRequestId: () => "request-1" },
  );
  await service.load("server-1");

  const directConversationId = await service.startPrivateConversation("member-1");

  assert.equal(directConversationId, "direct-1");
  assert.deepEqual(service.getSnapshot().directConversations, [direct]);
  assert.equal(scopes.length, 2);
  assert.equal(scopes[1]?.allowedConversations.at(-1)?.conversationId, "GROUPdirect-group-1");
});
