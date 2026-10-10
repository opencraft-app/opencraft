import {
  fireEvent,
  render,
} from "@testing-library/react-native";
import { createStore } from "zustand/vanilla";

import type { AppStoreState } from "../../application/app-store";
import HomeRoute from "../../app/(app)/home";
import { AppRuntimeProvider } from "../../runtime/app-runtime";

jest.mock("expo-router", () => {
  const {Text: MockText} = jest.requireActual("react-native");
  return {
    Redirect: ({href}: {href: string}) => <MockText>{href}</MockText>,
  };
});

describe("HomeRoute", () => {
  it("wires the empty state form to the workspace creation action", async () => {
    const createWorkspace = jest.fn(async () => undefined);
    const store = createStore<AppStoreState>(() =>
      ({
        authStatus: "signed_in",
        createWorkspace,
        currentChannelId: null,
        currentServerId: null,
        directConversations: [],
        directConversationSync: "complete",
        error: null,
        logout: jest.fn(async () => undefined),
        provisioningStage: null,
        provisioningWorkspace: false,
        servers: [],
        serversStatus: "ready",
      }) as unknown as AppStoreState,
    );
    const screen = await render(
      <AppRuntimeProvider store={store}>
        <HomeRoute />
      </AppRuntimeProvider>,
    );

    await fireEvent.changeText(
      screen.getByLabelText("Server 名称"),
      "Agent Network",
    );
    await fireEvent.press(
      screen.getByRole("button", { name: "创建并进入 Server" }),
    );

    expect(createWorkspace).toHaveBeenCalledWith({
      channelName: "general",
      serverName: "Agent Network",
      serverSlug: "agent-network",
      visibility: "public",
    });
  });

  it("opens the first visible Server root by slug", async () => {
    const store = createStore<AppStoreState>(() =>
      ({
        authStatus: "signed_in",
        createWorkspace: jest.fn(),
        currentChannelId: null,
        currentServerId: null,
        error: null,
        logout: jest.fn(),
        provisioningStage: null,
        provisioningWorkspace: false,
        servers: [
          {
            id: "server-1",
            imState: "ready",
            name: "Atlas",
            ownerMemberId: "member-1",
            revision: 1,
            slug: "atlas",
          },
        ],
        serversStatus: "ready",
      }) as unknown as AppStoreState,
    );
    const screen = await render(
      <AppRuntimeProvider store={store}>
        <HomeRoute />
      </AppRuntimeProvider>,
    );

    expect(screen.getByText("/s/atlas")).toBeVisible();
  });

  it("does not flash onboarding before Server discovery completes", async () => {
    const store = createStore<AppStoreState>(() =>
      ({
        authStatus: "signed_in",
        currentChannelId: null,
        currentServerId: null,
        directConversations: [],
        directConversationSync: "pending",
        error: null,
        provisioningStage: null,
        provisioningWorkspace: false,
        servers: [],
        serversStatus: "loading",
      }) as unknown as AppStoreState,
    );
    const screen = await render(
      <AppRuntimeProvider store={store}>
        <HomeRoute />
      </AppRuntimeProvider>,
    );

    expect(screen.getByText("正在连接 VELA")).toBeVisible();
    expect(screen.getByTestId("agent-network-mark")).toBeVisible();
    expect(screen.queryByText("R")).toBeNull();
    expect(screen.queryByLabelText("Server 名称")).toBeNull();
  });
});
