import assert from "node:assert/strict";
import test from "node:test";

import type {Channel} from "../platform/api.js";
import {
  channelAddress,
  conversationCapabilities,
  directAddress,
  isDirectAddress,
} from "./conversation.js";

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "channel-1",
    imGroupId: "community-1",
    imState: "ready",
    imTopicId: "topic-1",
    joined: true,
    name: "general",
    revision: 1,
    serverId: "server-1",
    visibility: "public",
    ...overrides,
  };
}

test("ChannelAddress requires a ready Topic mapping", () => {
  assert.deepEqual(channelAddress(channel()), {
    channelId: "channel-1",
    conversationId: "GROUPtopic-1",
    imGroupId: "community-1",
    imTopicId: "topic-1",
    targetId: "topic-1",
  });
  assert.equal(channelAddress(channel({imTopicId: null})), null);
});

test("Server 内私信地址 maps the authority resource to a Tencent group", () => {
  const value = {
    directConversationId: "direct-1",
    imGroupId: "an_dm_direct",
    imState: "ready",
  };
  const address = directAddress(value);

  assert.deepEqual(address, {
    conversationId: "GROUPan_dm_direct",
    directConversationId: "direct-1",
    imGroupId: "an_dm_direct",
    targetId: "an_dm_direct",
  });
  assert.equal(address ? isDirectAddress(address) : false, true);
  assert.equal(directAddress({...value, imState: "provisioning"}), null);
});

test("ChannelAddress rejects resources without a ready IM mapping", () => {
  assert.equal(channelAddress(channel({imState: "provisioning"})), null);
  assert.equal(
    channelAddress(channel({imGroupId: undefined, imTopicId: null})),
    null,
  );
});

test("ChannelAddress rejects discoverable channels before the member joins", () => {
  assert.equal(channelAddress(channel({joined: false})), null);
});

test("Conversation capabilities hide the provider address variant", () => {
  const group = channelAddress(channel());
  const direct = directAddress({
    directConversationId: "direct-1",
    imGroupId: "an_dm_direct",
    imState: "ready",
  });
  assert.deepEqual(group && conversationCapabilities(group), {
    historyCursor: "sequence",
    mentions: true,
    readReceipts: false,
    tasks: true,
    threads: true,
    topic: true,
  });
  assert.deepEqual(direct && conversationCapabilities(direct), {
    historyCursor: "timestamp",
    mentions: false,
    readReceipts: true,
    tasks: false,
    threads: false,
    topic: false,
  });
});
