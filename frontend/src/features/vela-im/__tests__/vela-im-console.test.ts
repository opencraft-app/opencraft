import { describe, expect, it } from "vitest";
import { agentConversations } from "../vela-im-console";
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
