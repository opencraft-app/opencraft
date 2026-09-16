import "./test-compat";

import type { HumanImSession } from "@lightvela/vela-chat-client-core";
import type { SdkMessage } from "./channel-chat-service";
import {
  TencentChatGateway,
  type RawTencentSdk,
  type TencentChatNamespace,
} from "./tencent-chat-gateway";

describe("TencentChatGateway", () => {
  it("registers the official upload plugin before login and exposes rich message factories", async () => {
    const order: string[] = [];
    const imageDraft = {
      ID: "image-1",
      conversationID: "GROUPtopic-1",
      flow: "out",
      from: "human-1",
      status: "unSend",
      time: 1_785_400_000,
      type: "TIMImageElem",
    };
    const fileDraft = {
      ...imageDraft,
      ID: "file-1",
      type: "TIMFileElem",
    };
    const rawSdk = {
      createFileMessage: jest.fn(() => fileDraft),
      createImageMessage: jest.fn(() => imageDraft),
      createTextAtMessage: jest.fn(),
      createTextMessage: jest.fn(),
      getMessageList: jest.fn(),
      login: jest.fn(async () => {
        order.push("login");
      }),
      logout: jest.fn(),
      off: jest.fn(),
      on: jest.fn(),
      registerPlugin: jest.fn(() => {
        order.push("plugin");
      }),
      setLogLevel: jest.fn(() => {
        order.push("log");
      }),
      sendMessage: jest.fn(),
    };
    const uploadPlugin = { upload: jest.fn() };
    const gateway = new TencentChatGateway(
      {
        create: () => rawSdk,
        EVENT: {
          KICKED_OUT: "kicked",
          MESSAGE_RECEIVED: "messages",
          SDK_NOT_READY: "not-ready",
          SDK_READY: "ready",
        },
        TYPES: {
          CONV_GROUP: "GROUP",
          KICKED_OUT_USERSIG_EXPIRED: "userSigExpired",
          MSG_FILE: "TIMFileElem",
          MSG_IMAGE: "TIMImageElem",
          MSG_TEXT: "TIMTextElem",
        },
      },
      { uploadPlugin },
    );

    await gateway.login({
      expiresAt: "2026-07-30T15:00:00Z",
      sdkAppId: 1_600_000_000,
      userId: "human_account-1",
      userSig: "redacted-user-sig",
    });

    expect(order).toEqual(["log", "plugin", "login"]);
    expect(rawSdk.setLogLevel).toHaveBeenCalledWith(1);
    expect(rawSdk.registerPlugin).toHaveBeenCalledWith({
      "tim-upload-plugin": uploadPlugin,
    });
    expect(gateway.createImageMessage({ payload: {} })).toBe(imageDraft);
    expect(gateway.createFileMessage({ payload: {} })).toBe(fileDraft);
  });

  it("binds lifecycle events before logging in the Human identity", async () => {
    const order: string[] = [];
    const handlers = new Map<string, (event?: unknown) => void>();
    const rawSdk: RawTencentSdk = {
      createTextAtMessage: jest.fn(),
      createTextMessage: jest.fn(),
      getMessageList: jest.fn(),
      login: jest.fn(async () => {
        order.push("login");
      }),
      logout: jest.fn(),
      off: jest.fn(),
      on: jest.fn((event, handler) => {
        order.push(`on:${event}`);
        handlers.set(event, handler);
      }),
      sendMessage: jest.fn(),
    };
    const namespace: TencentChatNamespace = {
      create: jest.fn(() => rawSdk),
      EVENT: {
        KICKED_OUT: "kicked",
        MESSAGE_RECEIVED: "messages",
        SDK_NOT_READY: "not-ready",
        SDK_READY: "ready",
      },
      TYPES: {
        CONV_GROUP: "GROUP",
        KICKED_OUT_USERSIG_EXPIRED: "userSigExpired",
        MSG_TEXT: "TEXT",
      },
    };
    const gateway = new TencentChatGateway(namespace);
    const observed: string[] = [];
    gateway.on("ready", () => observed.push("ready"));
    gateway.on("not_ready", () => observed.push("not_ready"));
    const session: HumanImSession = {
      expiresAt: "2026-07-30T15:00:00Z",
      sdkAppId: 1_600_000_000,
      userId: "human_account-1",
      userSig: "redacted-user-sig",
    };

    await gateway.login(session);
    handlers.get("ready")?.();
    handlers.get("not-ready")?.();

    expect(namespace.create).toHaveBeenCalledWith({
      SDKAppID: 1_600_000_000,
    });
    expect(order).toEqual([
      "on:ready",
      "on:not-ready",
      "on:kicked",
      "on:messages",
      "login",
    ]);
    expect(rawSdk.login).toHaveBeenCalledWith({
      userID: "human_account-1",
      userSig: "redacted-user-sig",
    });
    expect(observed).toEqual(["ready", "not_ready"]);
  });

  it("forwards MESSAGE_RECEIVED payloads to the message subscriber", async () => {
    const handlers = new Map<string, (event?: unknown) => void>();
    const rawSdk: RawTencentSdk = {
      createTextAtMessage: jest.fn(),
      createTextMessage: jest.fn(),
      getMessageList: jest.fn(),
      login: jest.fn(),
      logout: jest.fn(),
      off: jest.fn(),
      on: jest.fn((event, handler) => handlers.set(event, handler)),
      sendMessage: jest.fn(),
    };
    const gateway = new TencentChatGateway({
      create: () => rawSdk,
      EVENT: {
        KICKED_OUT: "kicked",
        MESSAGE_RECEIVED: "messages",
        SDK_NOT_READY: "not-ready",
        SDK_READY: "ready",
      },
      TYPES: {
        CONV_GROUP: "GROUP",
        KICKED_OUT_USERSIG_EXPIRED: "userSigExpired",
        MSG_TEXT: "TEXT",
      },
    });
    const received: SdkMessage[][] = [];
    gateway.onMessages((messages) => received.push(messages));
    await gateway.login({
      expiresAt: "2026-07-30T15:00:00Z",
      sdkAppId: 1_600_000_000,
      userId: "human_account-1",
      userSig: "redacted-user-sig",
    });
    const message: SdkMessage = {
      ID: "message-1",
      conversationID: "GROUPtopic-1",
      flow: "in",
      from: "agent-1",
      payload: { text: "完成了。" },
      status: "success",
      time: 1_785_400_000,
      type: "TEXT",
    };

    handlers.get("messages")?.({ data: [message] });

    expect(received).toEqual([[message]]);
  });

  it("forwards Tencent read and modified message updates through the same normalized stream", async () => {
    const handlers = new Map<string, (event?: unknown) => void>();
    const rawSdk = rawSdkWithHandlers(handlers);
    const gateway = new TencentChatGateway({
      create: () => rawSdk,
      EVENT: {
        KICKED_OUT: "kicked",
        MESSAGE_MODIFIED: "modified",
        MESSAGE_READ_BY_PEER: "peer-read",
        MESSAGE_READ_RECEIPT_RECEIVED: "group-read",
        MESSAGE_RECEIVED: "messages",
        SDK_NOT_READY: "not-ready",
        SDK_READY: "ready",
      },
      TYPES: {
        CONV_GROUP: "GROUP",
        KICKED_OUT_USERSIG_EXPIRED: "userSigExpired",
        MSG_TEXT: "TEXT",
      },
    });
    const updates: SdkMessage[][] = [];
    gateway.onMessages((messages) => updates.push(messages));
    await gateway.login({
      expiresAt: "2026-07-30T15:00:00Z",
      sdkAppId: 1_600_000_000,
      userId: "human_account-1",
      userSig: "redacted-user-sig",
    });
    const readMessage: SdkMessage = {
      ID: "message-1",
      conversationID: "GROUPtopic-1",
      flow: "out",
      from: "human_account-1",
      isPeerRead: true,
      status: "success",
      time: 1_785_400_000,
      type: "TEXT",
    };

    handlers.get("peer-read")?.({ data: [readMessage] });
    handlers.get("group-read")?.({ data: [readMessage] });
    handlers.get("modified")?.({ data: [readMessage] });

    expect(updates).toEqual([
      [readMessage],
      [readMessage],
      [readMessage],
    ]);
  });

  it("lists and streams normalized group conversation summaries", async () => {
    const handlers = new Map<string, (event?: unknown) => void>();
    const rawSdk = rawSdkWithHandlers(handlers);
    rawSdk.getTopicList = jest.fn(async () => ({
      data: {
        failureTopicList: [],
        successTopicList: [
          {
            lastMessage: {
              lastTime: 1_785_400_000,
              messageForShow: "刚刚完成部署",
            },
            topicID: "community-1@TOPIC#topic-1",
            topicName: "general",
            unreadCount: 8,
          },
        ],
      },
    }));
    const gateway = new TencentChatGateway({
      create: () => rawSdk,
      EVENT: {
        CONVERSATION_LIST_UPDATED: "conversations",
        KICKED_OUT: "kicked",
        MESSAGE_RECEIVED: "messages",
        SDK_NOT_READY: "not-ready",
        SDK_READY: "ready",
      },
      TYPES: {
        CONV_GROUP: "GROUP",
        CONV_TOPIC: "TOPIC",
        KICKED_OUT_USERSIG_EXPIRED: "userSigExpired",
        MSG_TEXT: "TEXT",
      },
    });
    const updates: unknown[] = [];
    gateway.onConversations((items) => updates.push(items));
    await gateway.login({
      expiresAt: "2026-07-30T15:00:00Z",
      sdkAppId: 1_600_000_000,
      userId: "human_account-1",
      userSig: "redacted-user-sig",
    });

    await expect(
      gateway.listConversations(["community-1", "community-1"]),
    ).resolves.toEqual({
      isSyncCompleted: true,
      items: [
        {
          conversationId: "GROUPcommunity-1@TOPIC#topic-1",
          kind: "group",
          lastMessageAt: "2026-07-30T08:26:40.000Z",
          lastMessagePreview: "刚刚完成部署",
          title: "general",
          unreadCount: 8,
        },
      ],
    });
    handlers.get("conversations")?.({
      data: [
        {
          conversationID: "GROUPtopic-1",
          lastMessage: {messageForShow: "状态已更新", time: 1_785_400_060},
          type: "GROUP",
          unreadCount: 3,
        },
      ],
    });

    expect(rawSdk.getTopicList).toHaveBeenCalledTimes(1);
    expect(rawSdk.getTopicList).toHaveBeenCalledWith({
      groupID: "community-1",
      topicIDList: undefined,
    });
    expect(updates).toEqual([
      [
        {
          conversationId: "GROUPtopic-1",
          kind: "group",
          lastMessageAt: "2026-07-30T08:27:40.000Z",
          lastMessagePreview: "状态已更新",
          title: "topic-1",
          unreadCount: 3,
        },
      ],
    ]);
  });

  it("keeps valid Topic summaries when one Community Group is stale", async () => {
    const handlers = new Map<string, (event?: unknown) => void>();
    const rawSdk = rawSdkWithHandlers(handlers);
    rawSdk.getTopicList = jest.fn(async ({groupID}) => {
      if (groupID === "stale-community") {
        throw Object.assign(new Error("GroupId is invalid"), {code: 10015});
      }
      return {
        data: {
          failureTopicList: [],
          successTopicList: [
            {
              topicID: "community-1@TOPIC#topic-1",
              topicName: "general",
              unreadCount: 0,
            },
          ],
        },
      };
    });
    const gateway = new TencentChatGateway({
      create: () => rawSdk,
      EVENT: {
        KICKED_OUT: "kicked",
        MESSAGE_RECEIVED: "messages",
        SDK_NOT_READY: "not-ready",
        SDK_READY: "ready",
      },
      TYPES: {
        CONV_GROUP: "GROUP",
        CONV_TOPIC: "TOPIC",
        KICKED_OUT_USERSIG_EXPIRED: "userSigExpired",
        MSG_TEXT: "TEXT",
      },
    });
    await gateway.login({
      expiresAt: "2026-07-30T15:00:00Z",
      sdkAppId: 1_600_000_000,
      userId: "human_account-1",
      userSig: "redacted-user-sig",
    });

    await expect(
      gateway.listConversations(["community-1", "stale-community"]),
    ).resolves.toMatchObject({
      isSyncCompleted: false,
      items: [
        expect.objectContaining({
          conversationId: "GROUPcommunity-1@TOPIC#topic-1",
          title: "general",
        }),
      ],
    });
  });

  it("classifies an expired UserSig kick without auto-classifying ordinary kicks", async () => {
    const handlers = new Map<string, (event?: unknown) => void>();
    const rawSdk = rawSdkWithHandlers(handlers);
    const gateway = new TencentChatGateway({
      create: () => rawSdk,
      EVENT: {
        KICKED_OUT: "kicked",
        MESSAGE_RECEIVED: "messages",
        SDK_NOT_READY: "not-ready",
        SDK_READY: "ready",
      },
      TYPES: {
        CONV_GROUP: "GROUP",
        KICKED_OUT_USERSIG_EXPIRED: "userSigExpired",
        MSG_TEXT: "TEXT",
      },
    });
    const kicks: unknown[] = [];
    gateway.on("kicked_out", (event) => kicks.push(event));
    await gateway.login({
      expiresAt: "2026-07-30T15:00:00Z",
      sdkAppId: 1_600_000_000,
      userId: "human_account-1",
      userSig: "redacted-user-sig",
    });

    handlers.get("kicked")?.({ data: { type: "userSigExpired" } });
    handlers.get("kicked")?.({ data: { type: "multipleDevice" } });

    expect(kicks).toEqual([
      { cause: "user_sig_expired" },
      {},
    ]);
  });

  it("ignores lifecycle and message events from an older SDK generation", async () => {
    const firstHandlers = new Map<string, (event?: unknown) => void>();
    const secondHandlers = new Map<string, (event?: unknown) => void>();
    const firstSdk = rawSdkWithHandlers(firstHandlers);
    const secondSdk = rawSdkWithHandlers(secondHandlers);
    const gateway = new TencentChatGateway({
      create: ({ SDKAppID }) =>
        SDKAppID === 1_600_000_001 ? firstSdk : secondSdk,
      EVENT: {
        KICKED_OUT: "kicked",
        MESSAGE_RECEIVED: "messages",
        SDK_NOT_READY: "not-ready",
        SDK_READY: "ready",
      },
      TYPES: {
        CONV_GROUP: "GROUP",
        KICKED_OUT_USERSIG_EXPIRED: "userSigExpired",
        MSG_TEXT: "TEXT",
      },
    });
    const ready: string[] = [];
    const messages: SdkMessage[][] = [];
    gateway.on("ready", () => ready.push("ready"));
    gateway.onMessages((items) => messages.push(items));
    await gateway.login({
      expiresAt: "2026-07-30T15:00:00Z",
      sdkAppId: 1_600_000_001,
      userId: "human_account-1",
      userSig: "redacted-first",
    });
    await gateway.login({
      expiresAt: "2026-07-30T16:00:00Z",
      sdkAppId: 1_600_000_002,
      userId: "human_account-1",
      userSig: "redacted-second",
    });
    const staleMessage: SdkMessage = {
      ID: "stale",
      conversationID: "GROUPtopic-1",
      flow: "in",
      from: "agent-1",
      status: "success",
      time: 1_785_400_000,
      type: "TEXT",
    };

    firstHandlers.get("ready")?.();
    firstHandlers.get("messages")?.({ data: [staleMessage] });
    secondHandlers.get("ready")?.();

    expect(ready).toEqual(["ready"]);
    expect(messages).toEqual([]);
    expect(firstSdk.off).toHaveBeenCalledTimes(4);
  });

  it("maps Tencent login code 70001 to an expired UserSig domain error", async () => {
    const handlers = new Map<string, (event?: unknown) => void>();
    const rawSdk = rawSdkWithHandlers(handlers);
    rawSdk.login = jest.fn(async () => {
      throw { code: 70001, message: "expired" };
    });
    const gateway = new TencentChatGateway({
      create: () => rawSdk,
      EVENT: {
        KICKED_OUT: "kicked",
        MESSAGE_RECEIVED: "messages",
        SDK_NOT_READY: "not-ready",
        SDK_READY: "ready",
      },
      TYPES: {
        CONV_GROUP: "GROUP",
        KICKED_OUT_USERSIG_EXPIRED: "userSigExpired",
        MSG_TEXT: "TEXT",
      },
    });

    await expect(
      gateway.login({
        expiresAt: "2026-07-30T15:00:00Z",
        sdkAppId: 1_600_000_000,
        userId: "human_account-1",
        userSig: "redacted-user-sig",
      }),
    ).rejects.toMatchObject({
      code: "IM_KICKED_OUT",
      details: { cause: "user_sig_expired" },
    });
  });
});

function rawSdkWithHandlers(
  handlers: Map<string, (event?: unknown) => void>,
): RawTencentSdk {
  return {
    createTextAtMessage: jest.fn(),
    createTextMessage: jest.fn(),
    getMessageList: jest.fn(),
    login: jest.fn(),
    logout: jest.fn(),
    off: jest.fn(),
    on: jest.fn((event, handler) => handlers.set(event, handler)),
    sendMessage: jest.fn(),
  };
}
