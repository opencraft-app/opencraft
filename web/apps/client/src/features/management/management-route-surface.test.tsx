import type {Account, Server} from "@raft-platform/client-core";
import {render, waitFor} from "@testing-library/react-native";
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
});
