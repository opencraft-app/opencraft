import {act, render, waitFor} from "@testing-library/react-native";
import {createStore} from "zustand/vanilla";

import type {AppStoreState} from "../../application/app-store";
import {AppRuntimeProvider} from "../../runtime/app-runtime";
import {WorkspaceConversationScreen} from "./workspace-conversation-screen";

jest.mock("expo-router", () => ({
  Redirect: ({href}: {href: string}) => {
    const {Text: MockText} = jest.requireActual("react-native");
    return <MockText>{href}</MockText>;
  },
  useRouter: () => ({push: jest.fn()}),
}));

describe("WorkspaceConversationScreen", () => {
  it("waits for cold-start DM discovery and opens the route when the peer appears", async () => {
    const selectDirectConversation = jest.fn(async () => undefined);
    const store = createStore<AppStoreState>(() =>
      ({
        activeConversation: null,
        authStatus: "signed_in",
        cancelOperationPolling: jest.fn(),
        currentServerId: null,
        directConversations: [],
        directConversationSync: "pending",
        members: [],
        operationsById: {},
        refreshOrganization: jest.fn(async () => undefined),
        selectDirectConversation,
        servers: [],
      }) as unknown as AppStoreState,
    );

    const screen = await render(
      <AppRuntimeProvider store={store}>
        <WorkspaceConversationScreen
          target={{directConversationId: "direct-1", kind: "direct"}}
        />
      </AppRuntimeProvider>,
    );

    expect(screen.getByText("正在连接 RAFT")).toBeVisible();
    expect(selectDirectConversation).not.toHaveBeenCalled();

    await act(async () => {
      store.setState({
        directConversations: [
          {
            conversationId: "GROUPan_dm_direct_1",
            directConversationId: "direct-1",
            imGroupId: "an_dm_direct_1",
            imState: "ready",
            lastMessagePreview: "",
            peerDisplayName: "研究助手",
            peerMemberId: "member-agent-1",
            peerUserId: "agent-im-1",
            unreadCount: 0,
          },
        ],
        directConversationSync: "complete",
      });
    });

    await waitFor(() => {
      expect(selectDirectConversation).toHaveBeenCalledWith("agent-im-1");
    });
  });
});
