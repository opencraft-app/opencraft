import {describe, expect, it} from "@jest/globals";

import type {
  AppMessagingPort,
  PlatformPort,
} from "../application/app-store";
import {createInjectedStore} from "./injected-runtime";

describe("createInjectedStore", () => {
  it("builds the canonical AppStore from caller-owned ports", async () => {
    const platform = {} as PlatformPort;
    const unsubscribe = () => undefined;
    const subscribeLifecycle = jest.fn(() => unsubscribe);
    const subscribeConversations = jest.fn(() => unsubscribe);
    const subscribeMessages = jest.fn(() => unsubscribe);
    const messaging = {
      subscribeConversations,
      subscribeLifecycle,
      subscribeMessages,
    } as unknown as AppMessagingPort;
    const store = createInjectedStore({messaging, platform});

    expect(subscribeLifecycle).toHaveBeenCalledTimes(1);
    expect(subscribeConversations).toHaveBeenCalledTimes(1);
    expect(subscribeMessages).toHaveBeenCalledTimes(1);
    expect(store.getState().authStatus).toBe("checking");
  });
});
