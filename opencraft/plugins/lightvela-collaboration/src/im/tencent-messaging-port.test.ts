import "./test-compat";

import type {
  ConversationSummary,
  HumanImSession,
  Message,
  MessagingLifecycleEvent,
} from "@lightvela/vela-chat-client-core";
import type { SdkMessage } from "./channel-chat-service";
import { TencentMessagingPort } from "./tencent-messaging-port";

const session: HumanImSession = {
  expiresAt: "2026-07-31T12:00:00.000Z",
  sdkAppId: 1_600_154_578,
  userId: "human-1",
  userSig: "redacted-test-usersig",
};

const normalizedMessage: Message = {
  content: { kind: "text", text: "已完成。" },
  conversationId: "GROUPtopic-1",
  createdAt: "2026-07-31T10:00:00.000Z",
  delivery: { state: "sent" },
  direction: "incoming",
  id: "message-1",
  kind: "text",
  mentions: [],
  rawType: "TIMTextElem",
  reactions: [],
  read: { state: "unknown" },
  senderId: "agent-1",
  senderName: "研究助手",
  text: "已完成。",
};

describe("TencentMessagingPort", () => {
  it("filters live messages to the current Server scope", async () => {
    let rawMessageHandler: ((messages: SdkMessage[]) => void) | undefined;
    const port = new TencentMessagingPort({
      chat: {
        loadHistory: jest.fn(),
        loadMessageContext: jest.fn(),
        loadMessagesByReferences: jest.fn(),
        markRead: jest.fn(),
        normalizeMessages: jest.fn(() => [
          normalizedMessage,
          {
            ...normalizedMessage,
            conversationId: "GROUPtopic-outside",
            id: "message-outside",
          },
        ]),
        reconcileMessage: jest.fn(async () => ({state: "pending" as const})),
        retryMessage: jest.fn(),
        searchMessages: jest.fn(),
        sendAttachment: jest.fn(),
        sendTask: jest.fn(),
        sendText: jest.fn(),
        setReaction: jest.fn(),
      },
      gateway: {
        login: jest.fn(),
        logout: jest.fn(),
        on: jest.fn(() => () => undefined),
        onMessages: jest.fn((listener: (messages: SdkMessage[]) => void) => {
          rawMessageHandler = listener;
          return () => {
            rawMessageHandler = undefined;
          };
        }),
      },
    });
    const updates: Message[][] = [];
    port.subscribeMessages((messages) => updates.push(messages));
    await port.setScope({
      allowedConversations: [
        {
          channelId: "channel-1",
          conversationId: "GROUPtopic-1",
          imGroupId: "community-1",
          imTopicId: "topic-1",
          targetId: "topic-1",
        },
      ],
      generation: 1,
    });

    rawMessageHandler?.([]);

    expect(updates).toEqual([[normalizedMessage]]);
  });

  it("exposes Tencent lifecycle and live messages through client-core", async () => {
    const eventHandlers = new Map<
      string,
      (event?: { cause?: "user_sig_expired" }) => void
    >();
    let rawMessageHandler: ((messages: SdkMessage[]) => void) | undefined;
    const gateway = {
      login: jest.fn(async () => undefined),
      logout: jest.fn(async () => undefined),
      on: jest.fn((event: string, listener: () => void) => {
        eventHandlers.set(event, listener);
        return () => eventHandlers.delete(event);
      }),
      onMessages: jest.fn((listener: (messages: SdkMessage[]) => void) => {
        rawMessageHandler = listener;
        return () => {
          rawMessageHandler = undefined;
        };
      }),
    };
    const chat = {
      loadHistory: jest.fn(),
      loadMessageContext: jest.fn(),
      loadMessagesByReferences: jest.fn(),
      markRead: jest.fn(),
      normalizeMessages: jest.fn(() => [normalizedMessage]),
      reconcileMessage: jest.fn(async () => ({state: "pending" as const})),
      retryMessage: jest.fn(),
      searchMessages: jest.fn(),
      sendAttachment: jest.fn(),
      sendTask: jest.fn(),
      sendText: jest.fn(),
      setReaction: jest.fn(),
    };
    const port = new TencentMessagingPort({ chat, gateway });
    const lifecycle: MessagingLifecycleEvent[] = [];
    const messages: Message[][] = [];
    port.subscribeLifecycle((event) => lifecycle.push(event));
    port.subscribeMessages((items) => messages.push(items));

    await port.connect(session);
    eventHandlers.get("ready")?.();
    rawMessageHandler?.([
      {
        ID: "message-1",
        conversationID: "GROUPtopic-1",
        flow: "in",
        from: "agent-1",
        status: "success",
        time: 1_785_400_000,
        type: "TIMTextElem",
      },
    ]);
    await port.waitUntilReady(50);
    eventHandlers.get("kicked_out")?.({
      cause: "user_sig_expired",
    });
    eventHandlers.get("kicked_out")?.({});

    expect(gateway.login).toHaveBeenCalledWith(session);
    expect(lifecycle).toEqual([
      { type: "ready" },
      { cause: "user_sig_expired", type: "kicked_out" },
      {
        reason: "账号已在另一个浏览器中登录",
        type: "kicked_out",
      },
    ]);
    expect(messages).toEqual([[normalizedMessage]]);
  });

  it("delegates rich attachment sending to the Channel service", async () => {
    const sendAttachment = jest.fn(async () => ({
      ...normalizedMessage,
      kind: "image" as const,
      text: "[图片]",
    }));
    const gateway = {
      login: jest.fn(),
      logout: jest.fn(),
      on: jest.fn(() => () => undefined),
      onMessages: jest.fn(() => () => undefined),
    };
    const port = new TencentMessagingPort({
      chat: {
        loadHistory: jest.fn(),
        loadMessageContext: jest.fn(),
        loadMessagesByReferences: jest.fn(),
        markRead: jest.fn(),
        normalizeMessages: jest.fn(),
        reconcileMessage: jest.fn(async () => ({state: "pending" as const})),
        retryMessage: jest.fn(),
        searchMessages: jest.fn(),
        sendAttachment,
        sendTask: jest.fn(),
        sendText: jest.fn(),
        setReaction: jest.fn(),
      },
      gateway,
    });
    const input = {
      channel: {
        channelId: "channel-1",
        conversationId: "GROUPtopic-1",
        imGroupId: "community-1",
        imTopicId: "topic-1",
        targetId: "topic-1",
      },
      clientRequestId: "request-image-1",
      kind: "image" as const,
      source: {
        kind: "uri" as const,
        name: "diagram.png",
        uri: "file:///private/diagram.png",
      },
    };

    await port.sendAttachment(input);

    expect(sendAttachment).toHaveBeenCalledWith(input);
  });

  it("delegates search-result context loading to the Channel service", async () => {
    const loadMessageContext = jest.fn(async () => [normalizedMessage]);
    const port = new TencentMessagingPort({
      chat: {
        loadHistory: jest.fn(),
        loadMessageContext,
        loadMessagesByReferences: jest.fn(),
        markRead: jest.fn(),
        normalizeMessages: jest.fn(),
        reconcileMessage: jest.fn(async () => ({state: "pending" as const})),
        retryMessage: jest.fn(),
        searchMessages: jest.fn(),
        sendAttachment: jest.fn(),
        sendTask: jest.fn(),
        sendText: jest.fn(),
        setReaction: jest.fn(),
      },
      gateway: {
        login: jest.fn(),
        logout: jest.fn(),
        on: jest.fn(() => () => undefined),
        onMessages: jest.fn(() => () => undefined),
      },
    });
    const address = {
      channelId: "channel-1",
      conversationId: "GROUPtopic-1",
      imGroupId: "community-1",
      imTopicId: "topic-1",
      targetId: "topic-1",
    };
    const reference = {
      kind: "group" as const,
      messageId: "message-1",
      sequence: 50,
      timestamp: 1_785_400_050,
    };

    await expect(port.loadMessageContext(address, reference)).resolves.toEqual([
      normalizedMessage,
    ]);
    expect(loadMessageContext).toHaveBeenCalledWith(address, reference);
  });

  it("exposes group conversation summaries without a platform message database", async () => {
    const summary: ConversationSummary = {
      conversationId: "GROUPtopic-1",
      kind: "group",
      lastMessageAt: "2026-07-31T10:00:00.000Z",
      lastMessagePreview: "已完成",
      title: "general",
      unreadCount: 4,
    };
    let conversationHandler:
      | ((items: ConversationSummary[]) => void)
      | undefined;
    const gateway = {
      listConversations: jest.fn(async () => ({
        isSyncCompleted: true,
        items: [summary],
      })),
      login: jest.fn(),
      logout: jest.fn(),
      on: jest.fn(() => () => undefined),
      onConversations: jest.fn(
        (listener: (items: ConversationSummary[]) => void) => {
          conversationHandler = listener;
          return () => {
            conversationHandler = undefined;
          };
        },
      ),
      onMessages: jest.fn(() => () => undefined),
    };
    const port = new TencentMessagingPort({
      chat: {
        loadHistory: jest.fn(),
        loadMessageContext: jest.fn(),
        loadMessagesByReferences: jest.fn(),
        markRead: jest.fn(),
        normalizeMessages: jest.fn(),
        reconcileMessage: jest.fn(async () => ({state: "pending" as const})),
        retryMessage: jest.fn(),
        searchMessages: jest.fn(),
        sendAttachment: jest.fn(),
        sendTask: jest.fn(),
        sendText: jest.fn(),
        setReaction: jest.fn(),
      },
      gateway,
    });
    const updates: ConversationSummary[][] = [];
    port.subscribeConversations((items) => updates.push(items));

    await expect(port.listConversations(["community-1"])).resolves.toEqual({
      isSyncCompleted: true,
      items: [summary],
    });
    conversationHandler?.([summary]);

    expect(gateway.listConversations).toHaveBeenCalledWith(["community-1"]);
    expect(updates).toEqual([[summary]]);
  });
});
