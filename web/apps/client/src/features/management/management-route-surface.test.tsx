import type {Account, Computer, Server} from "@vela/client-core";
import {act, render, waitFor} from "@testing-library/react-native";
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
    await act(async () => {
      finishSlowRefresh?.();
      await Promise.resolve();
    });
    await act(async () => {
      jest.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(refreshComputers).toHaveBeenCalledTimes(2);

    await screen.unmount();
    jest.useRealTimers();
  });
});
