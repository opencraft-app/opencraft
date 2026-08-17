import {PlatformError} from "@vela/client-core";

import {
  createNativePlatformPort,
  NativeMessagingPort,
  type NativeModulesBridge,
} from "./native-modules";

describe("NativeMessagingPort", () => {
  it("maps safe provider rejection only for Topic history", async () => {
    const bridge: NativeModulesBridge = {
      call: jest.fn(async () => {
        throw {
          code: "NATIVE_CALL_FAILED",
          message: "消息服务请求失败",
          providerCode: "sdk_10007",
          requestId: "request-1",
          retryable: true,
        };
      }),
      protocol: "reactvaxis-native-module/v1",
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
    };
    const messaging = new NativeMessagingPort(bridge);

    await expect(
      messaging.loadHistory({
        channelId: "channel-1",
        conversationId: "GROUPtopic-1",
        imGroupId: "community-1",
        imTopicId: "topic-1",
        targetId: "topic-1",
      }),
    ).rejects.toMatchObject({
      code: "IM_NOT_MEMBER",
      platformCode: "sdk_10007",
    });

    await expect(
      messaging.loadHistory({
        conversationId: "GROUPdirect-1",
        directConversationId: "direct-1",
        imGroupId: "direct-1",
        targetId: "direct-1",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PlatformError>>({
        code: "PROTOCOL",
        platformCode: "sdk_10007",
      }),
    );
  });

  it("routes native topic events only to active subscriptions", () => {
    const bridge: NativeModulesBridge = {
      call: jest.fn(),
      protocol: "reactvaxis-native-module/v1",
      subscribe: jest.fn((_module, _topic, _payload, options) =>
        options.subscriptionId,
      ),
      unsubscribe: jest.fn(),
    };
    const messaging = new NativeMessagingPort(bridge);
    const listener = jest.fn();

    const unsubscribe = messaging.subscribeMessages(listener);
    const subscriptionId = (bridge.subscribe as jest.Mock).mock.calls[0]?.[3]
      .subscriptionId as string;
    messaging.dispatchNativeEvent({
      kind: "event",
      launchId: "ignored-by-js-router",
      payload: [{id: "message-1"}],
      sequence: 1,
      subscriptionId,
    });
    expect(listener).toHaveBeenCalledWith([{id: "message-1"}]);

    unsubscribe();
    messaging.dispatchNativeEvent({
      kind: "event",
      payload: [{id: "message-2"}],
      sequence: 2,
      subscriptionId,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(bridge.unsubscribe).toHaveBeenCalledWith(subscriptionId);
  });
});

describe("Native platform adapter", () => {
  it("reuses PlatformApi validation over native auth and request calls", async () => {
    const calls: Array<{method: string; module: string; payload: unknown}> = [];
    const account = {
      displayName: "Beordle",
      email: "beordle@example.test",
      id: "account-1",
      imState: "ready",
      imUserId: "human-1",
      revision: 1,
    };
    const bridge: NativeModulesBridge = {
      async call(module, method, payload) {
        calls.push({method, module, payload});
        if (method === "login" || method === "restore") return account;
        if (method === "request") {
          return {
            items: [
              {
                id: "server-1",
                imState: "ready",
                name: "111",
                ownerMemberId: "member-1",
                revision: 1,
                slug: "11111",
              },
            ],
            nextCursor: null,
          };
        }
        return null;
      },
      protocol: "reactvaxis-native-module/v1",
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
    };
    const platform = createNativePlatformPort(bridge);

    await expect(platform.login("beordle@example.test", "password")).resolves.toEqual(
      account,
    );
    await expect(platform.listServers()).resolves.toEqual([
      expect.objectContaining({id: "server-1", slug: "11111"}),
    ]);
    expect(calls).toEqual([
      {
        method: "login",
        module: "platform.v1",
        payload: {email: "beordle@example.test", password: "password"},
      },
      {
        method: "request",
        module: "platform.v1",
        payload: expect.objectContaining({method: "GET", path: "/servers"}),
      },
    ]);
  });

  it("restores through the native session without real JS credentials", async () => {
    const account = {
      displayName: "Beordle",
      email: "beordle@example.test",
      id: "account-1",
      imState: "ready" as const,
      revision: 1,
    };
    const bridge: NativeModulesBridge = {
      async call(_module, method, payload) {
        if (method === "restore") return account;
        if (method === "request" && (payload as {path: string}).path === "/me") {
          return account;
        }
        throw new Error(`unexpected native call ${method}`);
      },
      protocol: "reactvaxis-native-module/v1",
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
    };

    await expect(createNativePlatformPort(bridge).restore()).resolves.toEqual(
      account,
    );
  });
});
