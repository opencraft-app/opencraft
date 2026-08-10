import type {Message} from "@vela/client-core";

import {
  messageStatusPresentation,
  participantDirectory,
  resolveMessageActor,
} from "@/ui";

function message(overrides: Partial<Message> = {}): Message {
  const text = overrides.text ?? "消息";
  return {
    content: {kind: "text", text},
    conversationId: "GROUPtopic-1",
    createdAt: "2026-08-10T10:00:00.000Z",
    delivery: {state: "sent"},
    direction: "outgoing",
    id: "message-1",
    kind: "text",
    mentions: [],
    rawType: "TIMTextElem",
    reactions: [],
    read: {state: "unknown"},
    senderId: "human-1",
    senderName: "你好",
    text,
    ...overrides,
  };
}

describe("message presentation", () => {
  it("does not infer self from outgoing direction when the current user id is missing", () => {
    expect(
      resolveMessageActor(
        message(),
        undefined,
        participantDirectory([
          {displayName: "你好", imUserId: "human-1", kind: "human"},
        ]),
      ),
    ).toEqual({kind: "human", label: "你好"});
  });

  it("uses participant data to recover an Agent label when message metadata is empty", () => {
    expect(
      resolveMessageActor(
        message({senderId: "agent-1", senderName: ""}),
        "human-1",
        participantDirectory([
          {displayName: "研究助手", imUserId: "agent-1", kind: "agent"},
        ]),
      ),
    ).toEqual({kind: "agent", label: "研究助手"});
  });

  it("does not show Thread index state on an incoming message", () => {
    expect(
      messageStatusPresentation({
        canRetryDelivery: true,
        canRetryIndex: true,
        indexPending: true,
        isGroupTail: true,
        message: message({direction: "incoming"}),
        receiptPolicy: "none",
      }),
    ).toEqual({kind: "hidden"});
  });

  it.each([
    {
      delivery: {error: "网络异常", retryable: true, state: "failed"} as const,
      expected: {kind: "failed", label: "发送失败 · 网络异常", retry: "delivery"},
    },
    {
      delivery: {progress: 0.42, state: "uploading"} as const,
      expected: {kind: "uploading", label: "上传 42%"},
    },
    {
      delivery: {state: "sending"} as const,
      expected: {kind: "sending", label: "发送中"},
    },
  ])("keeps $delivery.state ahead of index and receipt state", ({delivery, expected}) => {
    expect(
      messageStatusPresentation({
        canRetryDelivery: true,
        canRetryIndex: true,
        indexPending: true,
        isGroupTail: true,
        message: message({delivery, read: {state: "read"}}),
        receiptPolicy: "direct",
      }),
    ).toEqual(expected);
  });
});
