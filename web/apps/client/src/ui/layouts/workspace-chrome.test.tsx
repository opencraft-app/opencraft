import type {Account, Server} from "@vela/client-core";
import {render} from "@testing-library/react-native";
import {Text, View} from "react-native";

import {
  WorkspaceChrome,
  useRegisterCompactNavigation,
  useWorkspaceChromeHost,
  workspaceSectionBody,
} from "./workspace-chrome";

const account: Account = {
  displayName: "Skip",
  email: "skip@example.test",
  id: "account-1",
  imState: "ready",
  imUserId: "human-1",
  revision: 1,
};

const server: Server = {
  id: "server-1",
  imState: "ready",
  name: "Atlas",
  ownerMemberId: "member-1",
  revision: 1,
  slug: "atlas",
};

function HostProbe() {
  const hosted = useWorkspaceChromeHost();
  return <Text testID="chrome-host">{hosted ? "hosted" : "alone"}</Text>;
}

function CompactNavProbe() {
  useRegisterCompactNavigation(() => (
    <View testID="registered-compact-nav">
      <Text>chat-bar</Text>
    </View>
  ));
  return <Text testID="section-body">section</Text>;
}

describe("WorkspaceChrome", () => {
  it("marks descendants as chrome-hosted and keeps one bottom bar", async () => {
    const screen = await render(
      <WorkspaceChrome
        account={account}
        activeSection="tasks"
        canManageServer
        currentServerId={server.id}
        imStatus="ready"
        onNavigateSection={() => undefined}
        onSelectServer={() => undefined}
        servers={[server]}
        viewportWidth={390}
      >
        <HostProbe />
      </WorkspaceChrome>,
    );

    expect(screen.getByTestId("chrome-host")).toHaveTextContent("hosted");
    expect(screen.getAllByTestId("mobile-bottom-nav")).toHaveLength(1);
    expect(
      screen.getByRole("button", {name: "打开 Server 设置"}),
    ).toBeVisible();
  });

  it("lets chat register a compact bar and clears it when chat unmounts", async () => {
    const screen = await render(
      <WorkspaceChrome
        account={account}
        activeSection="chat"
        canManageServer
        currentServerId={server.id}
        imStatus="ready"
        onNavigateSection={() => undefined}
        onSelectServer={() => undefined}
        servers={[server]}
        viewportWidth={390}
      >
        <CompactNavProbe />
      </WorkspaceChrome>,
    );

    expect(screen.getByTestId("registered-compact-nav")).toBeVisible();
    expect(screen.queryByTestId("mobile-bottom-nav")).toBeNull();

    await screen.rerender(
      <WorkspaceChrome
        account={account}
        activeSection="tasks"
        canManageServer
        currentServerId={server.id}
        imStatus="ready"
        onNavigateSection={() => undefined}
        onSelectServer={() => undefined}
        servers={[server]}
        viewportWidth={390}
      >
        <Text testID="tasks-body">tasks</Text>
      </WorkspaceChrome>,
    );

    expect(screen.queryByTestId("registered-compact-nav")).toBeNull();
    expect(screen.getByTestId("mobile-bottom-nav")).toBeVisible();
  });

  it("lays out sidebar and stage in an explicit row", async () => {
    const screen = await render(
      <>
        {workspaceSectionBody(
          <View testID="sidebar" />,
          <View testID="stage" />,
        )}
      </>,
    );

    const sidebar = screen.getByTestId("sidebar");
    const stage = screen.getByTestId("stage");
    expect(sidebar).toBeTruthy();
    expect(stage).toBeTruthy();
    expect(sidebar.parent).toBe(stage.parent);
    expect(sidebar.parent).toHaveStyle({flexDirection: "row"});
  });
});
