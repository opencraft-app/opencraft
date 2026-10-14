import { describe, expect, it } from "vitest";
import { agentConversations, botsNeedingIdentity } from "../vela-im-console";
import type { VelaImController } from "../use-vela-im";
import type { ConversationItem } from "../vela-im-model";

const conversation = (kind: "C2C" | "GROUP", targetID: string): ConversationItem => ({
  conversationID: `${kind}${targetID}`, kind, targetID, name: targetID, lastText: "", lastTime: 0, unread: 0, isPinned: false,
});

describe("agentConversations", () => {
  const im = {
    conversations: [
      conversation("C2C", "b_alpha"),
      conversation("C2C", "b_beta"),
      conversation("C2C", "u_friend"),
      conversation("GROUP", "group-with-alpha"),
      conversation("GROUP", "group-with-beta"),
      conversation("GROUP", "group-not-loaded"),
    ],
    groupMembers: { "group-with-alpha": ["u_me", "b_alpha"], "group-with-beta": ["u_me", "b_beta"] },
  } as unknown as VelaImController;

  it("lists only the selected Agent's single chat and the groups it is in", () => {
    expect(agentConversations(im, "b_alpha").map((c) => c.targetID)).toEqual(["b_alpha", "group-with-alpha"]);
    expect(agentConversations(im, "b_beta").map((c) => c.targetID)).toEqual(["b_beta", "group-with-beta"]);
  });

  it("lists nothing for an Agent without an IM identity yet", () => {
    expect(agentConversations(im, null)).toEqual([]);
    expect(agentConversations(im, "b_new")).toEqual([]);
  });
});

describe("botsNeedingIdentity", () => {
  const bot = (id: string) => ({ id, instanceId: "ins-1", name: id });
  const agent = (botId: string, state: "provisioning" | "ready" | "error" | "deleted") => ({
    id: `agent-${botId}`, instanceId: "ins-1", botId, displayName: botId, userId: `a_${botId}`, state,
    commandPolicy: "owner" as const, revision: 1,
  });
  const bots = ["new", "ready", "failed", "stopped", "starting"].map(bot);
  const agents = [agent("ready", "ready"), agent("failed", "error"), agent("stopped", "deleted"), agent("starting", "provisioning")];

  it("starts Agents without an identity and failed ones, never stopped ones", () => {
    const needing = botsNeedingIdentity(agents, bots, 1_000_000, new Map(), new Map());
    expect(needing.map((b) => b.id)).toEqual(["new", "failed"]);
  });

  it("starts a provisioning record again once it has been stuck for a while", () => {
    const since = new Map<string, number>();
    expect(botsNeedingIdentity(agents, bots, 1_000_000, new Map(), since).map((b) => b.id)).not.toContain("starting");
    expect(botsNeedingIdentity(agents, bots, 1_000_000 + 3 * 60_000, new Map(), since).map((b) => b.id)).toContain("starting");
  });

  it("waits a minute before asking again for the same Agent", () => {
    const attempted = new Map([["ins-1/new", 1_000_000]]);
    expect(botsNeedingIdentity(agents, bots, 1_000_000 + 30_000, attempted, new Map()).map((b) => b.id)).toEqual(["failed"]);
  });
});
