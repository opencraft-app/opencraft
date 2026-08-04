import assert from "node:assert/strict";
import test from "node:test";

import type {Agent, Channel, Member, Server} from "../platform/api.js";
import {PlatformError} from "../platform/errors.js";
import {
  agentMentionEligibility,
  resolveAgent,
  resolveChannel,
  resolveServer,
} from "./resources.js";

const servers: Server[] = [
  {
    id: "server-1",
    imState: "ready",
    name: "Atlas",
    ownerMemberId: "member-1",
    revision: 1,
    slug: "atlas",
  },
];

const channels: Channel[] = [
  {
    id: "channel-1",
    imGroupId: "community-1",
    imState: "ready",
    imTopicId: "topic-1",
    name: "general",
    revision: 1,
    serverId: "server-1",
    visibility: "public",
  },
  {
    id: "channel-2",
    imGroupId: "community-1",
    imState: "ready",
    imTopicId: "topic-2",
    name: "general",
    revision: 1,
    serverId: "server-1",
    visibility: "private",
  },
];

const agent: Agent = {
  credentialVersion: 1,
  desiredState: "running",
  displayName: "研究助手",
  handle: "research",
  id: "agent-1",
  imState: "ready",
  imUserId: "agent-im-1",
  observedState: "running",
  replyPolicy: "mention_and_dm",
  revision: 1,
  runtime: {kind: "codex"},
  serverId: "server-1",
};

const member: Member = {
  displayName: "研究助手",
  handle: "research",
  id: "member-agent-1",
  imState: "ready",
  imUserId: "agent-im-1",
  kind: "agent",
  revision: 1,
  role: "member",
  serverId: "server-1",
  status: "active",
};

test("resources resolve by their documented ID or human reference", () => {
  assert.equal(resolveServer(servers, "atlas").id, "server-1");
  assert.equal(resolveServer(servers, "server-1").slug, "atlas");
  assert.equal(resolveAgent([agent], "research").id, "agent-1");
  assert.equal(resolveAgent([agent], "agent-1").handle, "research");
});

test("ambiguous and missing resources fail explicitly", () => {
  assert.throws(
    () => resolveChannel(channels, "general"),
    (error) =>
      error instanceof PlatformError &&
      error.code === "RESOURCE_AMBIGUOUS",
  );
  assert.throws(
    () => resolveChannel(channels, "missing"),
    (error) =>
      error instanceof PlatformError &&
      error.code === "RESOURCE_NOT_FOUND",
  );
});

test("real mentions require a ready Agent who is an active Channel member", () => {
  assert.deepEqual(agentMentionEligibility(agent, [member]), {allowed: true});
  assert.deepEqual(agentMentionEligibility(agent, []), {
    allowed: false,
    reason: "Agent 尚未加入当前 Channel",
  });
  assert.deepEqual(
    agentMentionEligibility({...agent, imState: "provisioning"}, [member]),
    {
      allowed: false,
      reason: "Agent IM 身份尚未就绪",
    },
  );
});
