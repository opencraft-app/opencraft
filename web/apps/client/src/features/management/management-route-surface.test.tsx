import type {Account, Computer, Server} from "@vela/client-core";
import {act, render, waitFor} from "@testing-library/react-native";
import {AppState, type AppStateStatus} from "react-native";
import {createStore} from "zustand/vanilla";

import type {AppStoreState} from "../../application/app-store";
import {AppRuntimeProvider} from "../../runtime/app-runtime";
import {ManagementRouteSurface} from "./management-route-surface";

const server: Server = {
  id: "server-1",
  imState: "ready",
  name: "Atlas",
  ownerMemberId: "member-1",
  revision: 1,
  slug: "atlas",
};

const account: Account = {
  displayName: "Skip",
  email: "skip@example.test",
  id: "account-1",
  imState: "ready",
  imUserId: "human-1",
  revision: 1,
};

const waitingComputer: Computer = {
  connectionState: "unknown",
  id: "computer-1",
  lifecycleState: "active",
  name: "Mac",
  osType: "macos",
  revision: 1,
  serverId: server.id,
};

describe("ManagementRouteSurface", () => {
  it("connects the actual Agent page to the shared AppStore lifecycle", async () => {
    const refreshAgents = jest.fn(async () => undefined);
    const refreshComputers = jest.fn(async () => undefined);
    const refreshOrganization = jest.fn(async () => undefined);
    const cancelOperationPolling = jest.fn();
    const store = createStore<AppStoreState>(() =>
      ({
        account,
        agents: [],
        cancelOperationPolling,
        channels: [],
        computers: [],
        currentServerId: server.id,
        error: null,
        imState: {status: "ready"},
        loadingAgents: false,
        loadingComputers: false,
        members: [
          {
            accountId: account.id,
            displayName: account.displayName,
            id: "member-1",
            imState: "ready",
            imUserId: account.imUserId,
            kind: "human",
            revision: 1,
            role: "owner",
            serverId: server.id,
          },
        ],
        operationsById: {},
        pendingAction: null,
        refreshAgents,
        refreshComputers,
        refreshOrganization,
        servers: [server],
      }) as unknown as AppStoreState,
    );

    const screen = await render(
      <AppRuntimeProvider store={store}>
        <ManagementRouteSurface
          navigation={{
            navigateSection: jest.fn(),
            selectServer: jest.fn(),
          }}
          section="agents"
          server={server}
        />
      </AppRuntimeProvider>,
    );

    expect(screen.getByTestId("agent-stage-title")).toHaveTextContent("Agent");
    await waitFor(() => {
      expect(refreshAgents).toHaveBeenCalledTimes(1);
      expect(refreshComputers).toHaveBeenCalledTimes(1);
      expect(refreshOrganization).toHaveBeenCalledTimes(1);
    });
    await screen.unmount();
    await waitFor(() => {
      expect(cancelOperationPolling).toHaveBeenCalledTimes(1);
    });
  });

  it("renders section body without a second chrome when the layout owns it", async () => {
    const store = createStore<AppStoreState>(() =>
      ({
        account,
        agents: [],
        cancelOperationPolling: jest.fn(),
        channels: [],
        computers: [],
        currentServerId: server.id,
        error: null,
        imState: {status: "ready"},
        loadingAgents: false,
        loadingComputers: false,
        members: [
          {
            accountId: account.id,
            displayName: account.displayName,
            id: "member-1",
            imState: "ready",
            imUserId: account.imUserId,
            kind: "human",
            revision: 1,
            role: "owner",
            serverId: server.id,
          },
        ],
        operationsById: {},
        pendingAction: null,
        refreshAgents: jest.fn(async () => undefined),
        refreshComputers: jest.fn(async () => undefined),
        refreshOrganization: jest.fn(async () => undefined),
        servers: [server],
      }) as unknown as AppStoreState,
    );

    const screen = await render(
      <AppRuntimeProvider store={store}>
        <ManagementRouteSurface
          chrome={false}
          navigation={{
            navigateSection: jest.fn(),
            selectServer: jest.fn(),
          }}
          section="agents"
          server={server}
        />
      </AppRuntimeProvider>,
    );

    expect(screen.getByTestId("agent-stage-title")).toHaveTextContent("Agent");
    expect(screen.queryByTestId("mobile-bottom-nav")).toBeNull();
    expect(screen.queryByTestId("workspace-shell")).toBeNull();
  });

  it("polls only while a Computer has never been observed", async () => {
    jest.useFakeTimers();
    const refreshComputers = jest.fn(async () => undefined);
    const store = createStore<AppStoreState>(() =>
      ({
        account,
        agents: [],
        cancelOperationPolling: jest.fn(),
        channels: [],
        computers: [waitingComputer],
        currentServerId: server.id,
        error: null,
        imState: {status: "ready"},
        loadingAgents: false,
        loadingComputers: false,
        members: [],
        operationsById: {},
        pendingAction: null,
        refreshAgents: jest.fn(async () => undefined),
        refreshComputers,
        refreshOrganization: jest.fn(async () => undefined),
        servers: [server],
      }) as unknown as AppStoreState,
    );

    const screen = await render(
      <AppRuntimeProvider store={store}>
        <ManagementRouteSurface
          navigation={{
            navigateSection: jest.fn(),
            selectServer: jest.fn(),
          }}
          section="computers"
          server={server}
        />
      </AppRuntimeProvider>,
    );
    await act(async () => undefined);
    expect(refreshComputers).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(refreshComputers).toHaveBeenCalledTimes(2);

    await act(async () => {
      store.setState({
        computers: [
          {
            ...waitingComputer,
            connectionState: "unknown",
            lastObservedAt: "2026-08-05T03:19:57.000Z",
          },
        ],
      });
    });
    await act(async () => undefined);
    await act(async () => {
      jest.advanceTimersByTime(4_000);
      await Promise.resolve();
    });
    expect(refreshComputers).toHaveBeenCalledTimes(2);

    await screen.unmount();
    jest.useRealTimers();
  });

  it("refreshes observed Computers every thirty seconds while active", async () => {
    jest.useFakeTimers();
    const refreshComputers = jest.fn(async () => undefined);
    const store = createStore<AppStoreState>(() =>
      ({
        account,
        agents: [],
        cancelOperationPolling: jest.fn(),
        channels: [],
        computers: [
          {
            ...waitingComputer,
            connectionState: "online",
            lastObservedAt: "2026-08-05T03:19:57.000Z",
          },
        ],
        currentServerId: server.id,
        error: null,
        imState: {status: "ready"},
        loadingAgents: false,
        loadingComputers: false,
        members: [],
        operationsById: {},
        pendingAction: null,
        refreshAgents: jest.fn(async () => undefined),
        refreshComputers,
        refreshOrganization: jest.fn(async () => undefined),
        servers: [server],
      }) as unknown as AppStoreState,
    );

    const screen = await render(
      <AppRuntimeProvider store={store}>
        <ManagementRouteSurface
          navigation={{
            navigateSection: jest.fn(),
            selectServer: jest.fn(),
          }}
          section="computers"
          server={server}
        />
      </AppRuntimeProvider>,
    );
    await act(async () => undefined);
    expect(refreshComputers).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(29_999);
      await Promise.resolve();
    });
    expect(refreshComputers).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(refreshComputers).toHaveBeenLastCalledWith({force: true});
    expect(refreshComputers).toHaveBeenCalledTimes(2);

    await screen.unmount();
    await act(async () => {
      jest.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(refreshComputers).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it("pauses Computer freshness refresh in background and refreshes on active", async () => {
    jest.useFakeTimers();
    let appStateListener: ((state: AppStateStatus) => void) | undefined;
    const appStateSubscription = {remove: jest.fn()};
    const appStateSpy = jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation((_type, listener) => {
        appStateListener = listener;
        return appStateSubscription;
      });
    const refreshComputers = jest.fn(async () => undefined);
    const store = createStore<AppStoreState>(() =>
      ({
        account,
        agents: [],
        cancelOperationPolling: jest.fn(),
        channels: [],
        computers: [
          {
            ...waitingComputer,
            connectionState: "online",
            lastObservedAt: "2026-08-05T03:19:57.000Z",
          },
        ],
        currentServerId: server.id,
        error: null,
        imState: {status: "ready"},
        loadingAgents: false,
        loadingComputers: false,
        members: [],
        operationsById: {},
        pendingAction: null,
        refreshAgents: jest.fn(async () => undefined),
        refreshComputers,
        refreshOrganization: jest.fn(async () => undefined),
        servers: [server],
      }) as unknown as AppStoreState,
    );

    const screen = await render(
      <AppRuntimeProvider store={store}>
        <ManagementRouteSurface
          navigation={{
            navigateSection: jest.fn(),
            selectServer: jest.fn(),
          }}
          section="computers"
          server={server}
        />
      </AppRuntimeProvider>,
    );
    await act(async () => undefined);
    expect(refreshComputers).toHaveBeenCalledTimes(1);
    expect(appStateListener).toBeDefined();

    await act(async () => {
      appStateListener?.("background");
      jest.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(refreshComputers).toHaveBeenCalledTimes(1);

    await act(async () => {
      appStateListener?.("active");
      await Promise.resolve();
    });
    expect(refreshComputers).toHaveBeenLastCalledWith({force: true});
    expect(refreshComputers).toHaveBeenCalledTimes(2);

    await screen.unmount();
    expect(appStateSubscription.remove).toHaveBeenCalledTimes(1);
    appStateSpy.mockRestore();
    jest.useRealTimers();
  });

  it("stops first-connection polling after two minutes of wall time", async () => {
    jest.useFakeTimers();
    let finishSlowRefresh: (() => void) | undefined;
    const refreshComputers = jest
      .fn<Promise<void>, []>()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            finishSlowRefresh = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const store = createStore<AppStoreState>(() =>
      ({
        account,
        agents: [],
        cancelOperationPolling: jest.fn(),
        channels: [],
        computers: [waitingComputer],
        currentServerId: server.id,
        error: null,
        imState: {status: "ready"},
        loadingAgents: false,
        loadingComputers: false,
        members: [],
        operationsById: {},
        pendingAction: null,
        refreshAgents: jest.fn(async () => undefined),
        refreshComputers,
        refreshOrganization: jest.fn(async () => undefined),
        servers: [server],
      }) as unknown as AppStoreState,
    );
    const screen = await render(
      <AppRuntimeProvider store={store}>
        <ManagementRouteSurface
          navigation={{
            navigateSection: jest.fn(),
            selectServer: jest.fn(),
          }}
          section="computers"
          server={server}
        />
      </AppRuntimeProvider>,
    );
    await act(async () => undefined);
    await act(async () => {
      jest.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(refreshComputers).toHaveBeenCalledTimes(2);

    await act(async () => {
      jest.advanceTimersByTime(120_000);
      await Promise.resolve();
    });
    const callsAfterExpiry = refreshComputers.mock.calls.length;
    expect(callsAfterExpiry).toBeGreaterThanOrEqual(3);
    await act(async () => {
      finishSlowRefresh?.();
      await Promise.resolve();
    });
    await act(async () => {
      jest.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(refreshComputers).toHaveBeenCalledTimes(callsAfterExpiry);

    await screen.unmount();
    jest.useRealTimers();
  });
});
