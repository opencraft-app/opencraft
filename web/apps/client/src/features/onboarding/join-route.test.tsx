import {act, fireEvent, render, waitFor} from "@testing-library/react-native";
import {createStore} from "zustand/vanilla";

import type {AppStoreState} from "../../application/app-store";
import JoinRoute from "../../app/join";
import {AppRuntimeProvider} from "../../runtime/app-runtime";
import {SessionJoinIntentStore} from "../../storage/session-join-intent-store";

const mockReplace = jest.fn();
const mockRouter = {replace: mockReplace};

jest.mock("expo-router", () => {
  const {Text: MockText} = jest.requireActual("react-native");
  return {
    Redirect: ({href}: {href: string}) => <MockText>{href}</MockText>,
    useRouter: () => mockRouter,
  };
});

class MemorySessionStorage {
  public readonly values = new Map<string, string>();

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("JoinRoute", () => {
  let sessionStorage: MemorySessionStorage;
  let replaceState: jest.Mock;

  beforeEach(() => {
    mockReplace.mockReset();
    replaceState = jest.fn();
    sessionStorage = new MemorySessionStorage();
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: sessionStorage,
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: {
        hash: "#token=rfi_join_token_long_enough_123",
        hostname: "app.example.test",
        pathname: "/join",
        search: "",
      },
    });
    Object.defineProperty(globalThis, "history", {
      configurable: true,
      value: {replaceState},
    });
  });

  it("removes the fragment before redirecting a signed-out Human to login", async () => {
    const store = createStore<AppStoreState>(() =>
      ({authStatus: "signed_out"}) as AppStoreState,
    );
    const screen = await render(
      <AppRuntimeProvider store={store}>
        <JoinRoute />
      </AppRuntimeProvider>,
    );

    await waitFor(() => {
      expect(replaceState).toHaveBeenCalledWith({}, "", "/join");
    });
    expect(screen.getByText("/login?returnTo=%2Fjoin")).toBeVisible();
    expect(new SessionJoinIntentStore(sessionStorage).load()).toBe(
      "rfi_join_token_long_enough_123",
    );
  });

  it("accepts the saved intent and enters the returned landing Channel", async () => {
    const acceptJoinLink = jest.fn(async () => ({
      landingChannelId: "channel-all",
      memberId: "member-1",
      operations: [],
      serverId: "server-1",
      serverSlug: "atlas",
    }));
    const store = createStore<AppStoreState>(() =>
      ({
        acceptJoinLink,
        agents: [{observedState: "running"}],
        authStatus: "signed_in",
        error: null,
        imState: {status: "ready"},
        pendingAction: null,
      }) as unknown as AppStoreState,
    );
    await render(
      <AppRuntimeProvider store={store}>
        <JoinRoute />
      </AppRuntimeProvider>,
    );

    await waitFor(() => {
      expect(acceptJoinLink).toHaveBeenCalledWith(
        "rfi_join_token_long_enough_123",
      );
      expect(mockReplace).toHaveBeenCalledWith("/s/atlas/c/channel-all");
    });
    expect(new SessionJoinIntentStore(sessionStorage).load()).toBeNull();
  });

  it("automatically resumes the saved join after registration IM identity becomes ready", async () => {
    jest.useFakeTimers();
    try {
      const store = createStore<AppStoreState>(() =>
        ({
          agents: [{observedState: "running"}],
          authStatus: "signed_in",
          error: null,
          imState: {status: "issuing_session"},
          joinLinkErrorKind: null,
          pendingAction: null,
        }) as unknown as AppStoreState,
      );
      const acceptJoinLink = jest
        .fn()
        .mockImplementationOnce(async () => {
          store.setState({joinLinkErrorKind: "identity_pending"});
          return null;
        })
        .mockImplementationOnce(async () => {
          store.setState({
            imState: {status: "ready"},
            joinLinkErrorKind: null,
          });
          return {
            landingChannelId: "channel-all",
            memberId: "member-1",
            operations: [],
            serverId: "server-1",
            serverSlug: "atlas",
          };
        });
      store.setState({acceptJoinLink});

      await render(
        <AppRuntimeProvider store={store}>
          <JoinRoute />
        </AppRuntimeProvider>,
      );

      await act(async () => {
        await jest.runOnlyPendingTimersAsync();
      });
      await waitFor(() => {
        expect(acceptJoinLink).toHaveBeenCalledTimes(2);
        expect(mockReplace).toHaveBeenCalledWith("/s/atlas/c/channel-all");
      });
      expect(new SessionJoinIntentStore(sessionStorage).load()).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps an accepted membership and retries only IM when chat is unavailable", async () => {
    const joined = {
      landingChannelId: "channel-all",
      memberId: "member-1",
      operations: [],
      serverId: "server-1",
      serverSlug: "atlas",
    };
    const store = createStore<AppStoreState>(() =>
      ({
        acceptJoinLink: jest.fn(async () => joined),
        agents: [{observedState: "running"}],
        authStatus: "signed_in",
        error: "聊天暂时无法连接",
        imState: {message: "聊天暂时无法连接", status: "error"},
        joinLinkErrorKind: null,
        pendingAction: null,
        reconnectIm: jest.fn(async () => {
          store.setState({error: null, imState: {status: "ready"}});
        }),
        selectChannel: jest.fn(async () => undefined),
      }) as unknown as AppStoreState,
    );

    const screen = await render(
      <AppRuntimeProvider store={store}>
        <JoinRoute />
      </AppRuntimeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("已加入协作空间，但聊天尚未连接")).toBeVisible();
    });
    expect(new SessionJoinIntentStore(sessionStorage).load()).toBeNull();
    expect(store.getState().acceptJoinLink).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole("button", {name: "重新连接聊天"}));

    await waitFor(() => {
      expect(store.getState().reconnectIm).toHaveBeenCalledTimes(1);
      expect(store.getState().selectChannel).toHaveBeenCalledWith("channel-all");
      expect(mockReplace).toHaveBeenCalledWith("/s/atlas/c/channel-all");
    });
    expect(store.getState().acceptJoinLink).toHaveBeenCalledTimes(1);
  });

  it("ignores an accepted result that resolves after the route unmounts", async () => {
    let resolveJoin!: (value: {
      landingChannelId: string;
      memberId: string;
      operations: never[];
      serverId: string;
      serverSlug: string;
    }) => void;
    const acceptJoinLink = jest.fn(
      () =>
        new Promise<{
          landingChannelId: string;
          memberId: string;
          operations: never[];
          serverId: string;
          serverSlug: string;
        }>((resolve) => {
          resolveJoin = resolve;
        }),
    );
    const store = createStore<AppStoreState>(() =>
      ({
        acceptJoinLink,
        agents: [{observedState: "running"}],
        authStatus: "signed_in",
        error: null,
        imState: {status: "ready"},
        joinLinkErrorKind: null,
        pendingAction: null,
      }) as unknown as AppStoreState,
    );
    const screen = await render(
      <AppRuntimeProvider store={store}>
        <JoinRoute />
      </AppRuntimeProvider>,
    );
    await waitFor(() => expect(acceptJoinLink).toHaveBeenCalledTimes(1));

    await act(async () => {
      screen.unmount();
      await Promise.resolve();
    });
    await act(async () => {
      resolveJoin({
        landingChannelId: "channel-all",
        memberId: "member-1",
        operations: [],
        serverId: "server-1",
        serverSlug: "atlas",
      });
      await Promise.resolve();
    });

    expect(mockReplace).not.toHaveBeenCalled();
    expect(new SessionJoinIntentStore(sessionStorage).load()).toBe(
      "rfi_join_token_long_enough_123",
    );
  });

  it("never overlaps a retry with an in-flight acceptance request", async () => {
    jest.useFakeTimers();
    try {
      let resolveFirst!: (value: null) => void;
      const store = createStore<AppStoreState>(() =>
        ({
          agents: [],
          authStatus: "signed_in",
          error: null,
          imState: {status: "issuing_session"},
          joinLinkErrorKind: null,
          pendingAction: null,
        }) as unknown as AppStoreState,
      );
      const acceptJoinLink = jest.fn(
        () =>
          new Promise<null>((resolve) => {
            resolveFirst = resolve;
          }),
      );
      store.setState({acceptJoinLink});
      const screen = await render(
        <AppRuntimeProvider store={store}>
          <JoinRoute />
        </AppRuntimeProvider>,
      );
      await waitFor(() => expect(acceptJoinLink).toHaveBeenCalledTimes(1));

      await act(async () => {
        await jest.advanceTimersByTimeAsync(30_000);
      });
      expect(acceptJoinLink).toHaveBeenCalledTimes(1);

      store.setState({joinLinkErrorKind: "identity_pending"});
      await act(async () => {
        resolveFirst(null);
        await Promise.resolve();
      });
      screen.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  it("caps automatic identity waiting and keeps the intent for a fresh manual window", async () => {
    jest.useFakeTimers();
    try {
      let identityReady = false;
      const store = createStore<AppStoreState>(() =>
        ({
          agents: [{observedState: "running"}],
          authStatus: "signed_in",
          error: "账号 IM 身份尚未就绪",
          imState: {status: "issuing_session"},
          joinLinkErrorKind: null,
          pendingAction: null,
        }) as unknown as AppStoreState,
      );
      const acceptJoinLink = jest.fn(async () => {
        if (!identityReady) {
          store.setState({joinLinkErrorKind: "identity_pending"});
          return null;
        }
        store.setState({imState: {status: "ready"}, joinLinkErrorKind: null});
        return {
          landingChannelId: "channel-all",
          memberId: "member-1",
          operations: [],
          serverId: "server-1",
          serverSlug: "atlas",
        };
      });
      store.setState({acceptJoinLink});
      const screen = await render(
        <AppRuntimeProvider store={store}>
          <JoinRoute />
        </AppRuntimeProvider>,
      );

      for (let elapsed = 0; elapsed <= 32_000; elapsed += 2_000) {
        await act(async () => {
          await jest.advanceTimersByTimeAsync(2_000);
        });
      }
      expect(screen.getByText("暂时无法加入")).toBeVisible();
      expect(new SessionJoinIntentStore(sessionStorage).load()).not.toBeNull();

      identityReady = true;
      await fireEvent.press(screen.getByRole("button", {name: "重试"}));

      await waitFor(() => {
        expect(mockReplace).toHaveBeenCalledWith("/s/atlas/c/channel-all");
      });
      expect(new SessionJoinIntentStore(sessionStorage).load()).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("sends an administrator without an Agent through Server setup", async () => {
    const acceptJoinLink = jest.fn(async () => ({
      landingChannelId: "channel-all",
      memberId: "member-1",
      operations: [],
      serverId: "server-1",
      serverSlug: "atlas",
    }));
    const store = createStore<AppStoreState>(() =>
      ({
        acceptJoinLink,
        account: {id: "account-1", imUserId: "human-1"},
        agents: [],
        authStatus: "signed_in",
        computers: [],
        error: null,
        imState: {status: "ready"},
        members: [
          {
            accountId: "account-1",
            id: "member-1",
            imUserId: "human-1",
            kind: "human",
            role: "admin",
            status: "active",
          },
        ],
        pendingAction: null,
      }) as unknown as AppStoreState,
    );

    await render(
      <AppRuntimeProvider store={store}>
        <JoinRoute />
      </AppRuntimeProvider>,
    );

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/s/atlas/setup");
    });
  });

  it("lets an ordinary member enter chat when only an administrator can create the missing Agent", async () => {
    const acceptJoinLink = jest.fn(async () => ({
      landingChannelId: "channel-all",
      memberId: "member-1",
      operations: [],
      serverId: "server-1",
      serverSlug: "atlas",
    }));
    const store = createStore<AppStoreState>(() =>
      ({
        acceptJoinLink,
        account: {id: "account-1", imUserId: "human-1"},
        agents: [],
        authStatus: "signed_in",
        computers: [],
        error: null,
        imState: {status: "ready"},
        members: [
          {
            accountId: "account-1",
            id: "member-1",
            imUserId: "human-1",
            kind: "human",
            role: "member",
            status: "active",
          },
        ],
        pendingAction: null,
      }) as unknown as AppStoreState,
    );

    await render(
      <AppRuntimeProvider store={store}>
        <JoinRoute />
      </AppRuntimeProvider>,
    );

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/s/atlas/c/channel-all");
    });
  });

  it("clears a terminal invalid invite instead of offering a futile retry", async () => {
    const store = createStore<AppStoreState>(() =>
      ({
        authStatus: "signed_in",
        error: null,
        joinLinkErrorKind: null,
        pendingAction: null,
      }) as unknown as AppStoreState,
    );
    const acceptJoinLink = jest.fn(async () => {
      store.setState({
        error: "邀请无效或已失效",
        joinLinkErrorKind: "terminal",
      });
      return null;
    });
    store.setState({acceptJoinLink});

    const screen = await render(
      <AppRuntimeProvider store={store}>
        <JoinRoute />
      </AppRuntimeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("加入链接无效")).toBeVisible();
    });
    expect(new SessionJoinIntentStore(sessionStorage).load()).toBeNull();
  });
});
