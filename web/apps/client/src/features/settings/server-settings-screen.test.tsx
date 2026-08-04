import type {Account, Server} from "@vela/client-core";
import {fireEvent, render, waitFor} from "@testing-library/react-native";

import {ServerSettingsScreen} from "@/ui";

const account: Account = {
  displayName: "Alice",
  email: "alice@example.test",
  id: "account-1",
  imState: "ready",
  imUserId: "u_ALICE",
  revision: 1,
};

const server: Server = {
  description: "Agent 协作空间",
  id: "server-1",
  imState: "ready",
  name: "Atlas",
  ownerMemberId: "member-1",
  revision: 1,
  slug: "atlas",
};

describe("ServerSettingsScreen", () => {
  it("edits display metadata while keeping the stable slug read-only", async () => {
    const onSave = jest.fn(async () => true);
    const screen = await render(
      <ServerSettingsScreen
        canManage
        currentAccount={account}
        error={null}
        onNavigateSection={jest.fn()}
        onSave={onSave}
        onSelectServer={jest.fn()}
        pendingAction={null}
        server={server}
        servers={[server]}
        viewportWidth={1200}
      />,
    );

    expect(screen.getByText("atlas")).toBeTruthy();
    expect(screen.queryByDisplayValue("atlas")).toBeNull();
    await fireEvent.changeText(
      screen.getByTestId("server-settings-name"),
      "Vela 研究实验室",
    );
    await fireEvent.changeText(
      screen.getByTestId("server-settings-description"),
      "协作与运行时研究",
    );
    await fireEvent.press(screen.getByTestId("server-settings-save"));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        description: "协作与运行时研究",
        name: "Vela 研究实验室",
      }),
    );
  });

  it("keeps the form read-only for an ordinary member", async () => {
    const screen = await render(
      <ServerSettingsScreen
        canManage={false}
        currentAccount={account}
        error={null}
        onNavigateSection={jest.fn()}
        onSave={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        server={server}
        servers={[server]}
        viewportWidth={1200}
      />,
    );

    expect(screen.getByText("只有 Server Owner 或管理员可以修改这些设置")).toBeTruthy();
    expect(screen.getByTestId("server-settings-name").props.editable).toBe(false);
  });
});
