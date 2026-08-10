import {render, waitFor} from "@testing-library/react-native";
import {createStore} from "zustand/vanilla";

import type {AppStoreState} from "../../application/app-store";
import JoinRoute from "../../app/join";
import {AppRuntimeProvider} from "../../runtime/app-runtime";
import {SessionJoinIntentStore} from "../../storage/session-join-intent-store";

const mockReplace = jest.fn();

jest.mock("expo-router", () => {
  const {Text: MockText} = jest.requireActual("react-native");
  return {
    Redirect: ({href}: {href: string}) => <MockText>{href}</MockText>,
    useRouter: () => ({replace: mockReplace}),
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
