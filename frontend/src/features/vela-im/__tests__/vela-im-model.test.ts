import { describe, expect, it } from "vitest";
import {
  applyRevoked,
  describeMessage,
  isAgentID,
  mergeMessages,
  messageAbstract,
  parseIDs,
  quoteCustomData,
  quotedMessage,
  resolveMentions,
  toApplications,
  toContacts,
  toConversations,
  timeDivider,
  toMembers,
} from "../vela-im-model";

describe("vela-im model", () => {
  it("normalizes conversations, hides system ones and keeps pinned first", () => {
    const list = toConversations([
      { conversationID: "C2Ca_1", type: "C2C", userProfile: { userID: "a_1", nick: "研究助手" }, lastMessage: { messageForShow: "好的", lastTime: 10 }, unreadCount: 2 },
      { conversationID: "GROUP@TGS#1", type: "GROUP", groupProfile: { groupID: "@TGS#1", name: "周报", memberCount: 4 }, lastMessage: { lastTime: 5 }, isPinned: true },
      { conversationID: "@TIM#SYSTEM", type: "@TIM#SYSTEM" },
      null,
    ]);
    expect(list.map((c) => c.conversationID)).toEqual(["GROUP@TGS#1", "C2Ca_1"]);
    expect(list[0]).toMatchObject({ kind: "GROUP", targetID: "@TGS#1", name: "周报", memberCount: 4, isPinned: true });
    expect(list[1]).toMatchObject({ kind: "C2C", targetID: "a_1", name: "研究助手", unread: 2, lastText: "好的" });
  });

  it("hides the preview of a revoked last message", () => {
    expect(toConversations([{ conversationID: "C2Ch_1", type: "C2C", lastMessage: { messageForShow: "secret", isRevoked: true } }])[0]?.lastText).toBe("");
  });

  it("normalizes contacts, members and friend applications", () => {
    expect(toContacts([{ userID: "h_1", remark: "老王", profile: { nick: "Wang" } }, { userID: "a_2", profile: { nick: "Bot" } }, {}]))
      .toEqual([{ userID: "h_1", name: "老王", remark: "老王" }, { userID: "a_2", name: "Bot" }]);
    expect(toMembers([{ userID: "h_1", role: "Owner", nick: "A" }, { userID: "a_1", role: "weird", nameCard: "群名片" }]))
      .toEqual([{ userID: "h_1", name: "A", role: "Owner" }, { userID: "a_1", name: "群名片", role: "Member" }]);
    expect(toApplications([{ userID: "h_2", nick: "B", wording: "你好", direction: "incoming" }, { userID: "h_3", direction: "outgoing" }]))
      .toEqual([{ userID: "h_2", name: "B", wording: "你好", direction: "incoming" }, { userID: "h_3", name: "h_3", wording: "", direction: "outgoing" }]);
  });

  it("resolves @mentions by name or ID, preferring the longest name, and @all", () => {
    const members = [{ userID: "a_1", name: "助手" }, { userID: "a_2", name: "研究助手" }, { userID: "h_1", name: "Alice" }];
    expect(resolveMentions("@研究助手 帮我看看", members)).toEqual(["a_2"]);
    expect(resolveMentions("@助手 和 @h_1", members).sort()).toEqual(["a_1", "h_1"]);
    expect(resolveMentions("@所有人 开会", members)).toEqual(["@all"]);
    expect(resolveMentions("email me at x@y", members)).toEqual([]);
  });

  it("merges messages by ID in time then sequence order and applies V4 revoke events", () => {
    const a = { ID: "1", time: 10, sequence: 1, conversationID: "C" };
    const b = { ID: "2", time: 10, sequence: 2, conversationID: "C" };
    const merged = mergeMessages([b], [a, { ...b, payload: { text: "edited" } }]);
    expect(merged.map((m) => m.ID)).toEqual(["1", "2"]);
    expect(merged[1]?.payload).toEqual({ text: "edited" });
    const revoked = applyRevoked(merged, [{ ID: "", conversationID: "C", sequence: 2 }]);
    expect(revoked.map((m) => Boolean(m.isRevoked))).toEqual([false, true]);
  });

  it("describes every message type and keeps unknown ones visible", () => {
    expect(describeMessage({ ID: "1", type: "TIMTextElem", payload: { text: "hi" } })).toEqual({ kind: "text", text: "hi" });
    expect(describeMessage({ ID: "2", type: "TIMImageElem", payload: { imageInfoArray: [{ url: "https://x/s.png" }, { url: "https://x/l.png" }] } }))
      .toEqual({ kind: "image", url: "https://x/s.png", fullUrl: "https://x/l.png" });
    expect(describeMessage({ ID: "3", type: "TIMFileElem", payload: { fileUrl: "javascript:alert(1)", fileName: "a.pdf", fileSize: 2048 } }))
      .toEqual({ kind: "file", url: "", name: "a.pdf", size: 2048 });
    expect(describeMessage({ ID: "4", type: "TIMRelayElem", payload: { title: "记录", abstractList: ["a", "b"] } })).toEqual({ kind: "merger", title: "记录", abstracts: ["a", "b"] });
    expect(describeMessage({ ID: "5", type: "TIMTextElem", isRevoked: true })).toEqual({ kind: "revoked" });
    expect(describeMessage({ ID: "6", type: "TIMNewElem" })).toEqual({ kind: "unknown", label: "TIMNewElem" });
  });

  it("turns Tencent group notices into system events instead of chat bubbles", () => {
    const created = { ID: "c", type: "TIMCustomElem", payload: { data: JSON.stringify({ businessID: "group_create", content: "创建群组", cmd: 0, opUser: "h_1", version: 4 }) } };
    expect(describeMessage(created)).toEqual({ kind: "event", event: "created", operator: "h_1", targets: [] });
    expect(describeMessage({ ID: "j", type: "TIMGroupTipElem", payload: { operationType: 1, operatorID: "h_1", userIDList: ["a_1", "a_2"] } }))
      .toEqual({ kind: "event", event: "joined", operator: "h_1", targets: ["a_1", "a_2"] });
    expect(describeMessage({ ID: "k", type: "TIMGroupTipElem", payload: { operationType: 3, operatorID: "h_1", memberList: [{ userID: "a_2" }] } }))
      .toEqual({ kind: "event", event: "kicked", operator: "h_1", targets: ["a_2"] });
    const policy = { businessID: "vela_group_policy", groupId: "0192f3c4-0000-7000-8000-000000000001", replyMode: "all", revision: 3 };
    expect(describeMessage({ ID: "p", type: "TIMCustomElem", payload: { data: JSON.stringify(policy) } }))
      .toEqual({ kind: "event", event: "reply_mode_changed", operator: "all", targets: [] });
    expect(describeMessage({ ID: "x", type: "TIMCustomElem", payload: { data: "not json", description: "卡片" } })).toEqual({ kind: "custom", description: "卡片", data: "not json" });
    expect(toConversations([{ conversationID: "GROUPg", type: "GROUP", groupProfile: { groupID: "g", name: "群" }, lastMessage: { type: "TIMCustomElem", messageForShow: "[自定义消息]", payload: created.payload } }])[0]?.lastText).toBe("");
  });

  it("recognizes Agent IDs and parses pasted ID lists", () => {
    expect(isAgentID("a_123")).toBe(true);
    expect(isAgentID("h_123")).toBe(false);
    expect(parseIDs("a_1, h_2，a_1\nh_3")).toEqual(["a_1", "h_2", "h_3"]);
  });

  it("quotes messages with Tencent's messageReply convention and a one-line abstract", () => {
    const original = { ID: "m1", type: "TIMTextElem", payload: { text: "第一行\n第二行" } };
    expect(messageAbstract(original)).toBe("第一行 第二行");
    expect(messageAbstract({ ID: "m2", type: "TIMImageElem", payload: {} })).toBe("[图片]");
    const data = quoteCustomData({ messageID: "m1", sender: "Alice", abstract: messageAbstract(original) });
    expect(quotedMessage({ ID: "m3", cloudCustomData: data })).toEqual({ messageID: "m1", sender: "Alice", abstract: "第一行 第二行" });
    expect(quotedMessage({ ID: "m4", cloudCustomData: JSON.stringify({ vela: { hops: 1 } }) })).toBeNull();
    expect(quotedMessage({ ID: "m5", cloudCustomData: "oops" })).toBeNull();
  });

  it("puts a time divider at a new day or after a five-minute gap", () => {
    const now = new Date(2026, 9, 12, 18, 0).getTime();
    const at = (h: number, m: number, day = 12) => Math.floor(new Date(2026, 9, day, h, m).getTime() / 1000);
    expect(timeDivider(undefined, { ID: "a", time: at(17, 0) }, now)).toBe("17:00");
    expect(timeDivider({ ID: "a", time: at(17, 0) }, { ID: "b", time: at(17, 3) }, now)).toBeNull();
    expect(timeDivider({ ID: "b", time: at(17, 3) }, { ID: "c", time: at(17, 9) }, now)).toBe("17:09");
    expect(timeDivider(undefined, { ID: "d", time: at(9, 5, 11) }, now)).toBe("昨天 09:05");
    expect(timeDivider(undefined, { ID: "e", time: at(9, 5, 1) }, now)).toBe("10月1日 09:05");
  });
});
