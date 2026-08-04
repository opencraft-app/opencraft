import {
  act,
  fireEvent,
  render,
} from "@testing-library/react-native";

import {
  FirstWorkspaceScreen,
  makeServerSlug,
} from "./first-workspace-screen";
import {
  PresentationProvider,
  type HumanClientPresenter,
  type WorkspaceSetupModel,
} from "@/ui";

describe("FirstWorkspaceScreen", () => {
  it("derives an editable slug and submits the public default Channel", async () => {
    const onSubmit = jest.fn();
    const screen = await render(
      <FirstWorkspaceScreen
        onLogout={jest.fn()}
        onSubmit={onSubmit}
      />,
    );

    await fireEvent.changeText(
      screen.getByLabelText("Server 名称"),
      "Agent Network",
    );

    expect(screen.getByLabelText("Server 标识").props.value).toBe(
      "agent-network",
    );
    expect(screen.getByLabelText("首个 Channel").props.value).toBe(
      "general",
    );

    await fireEvent.press(
      screen.getByRole("button", { name: "创建并进入 Server" }),
    );

    expect(onSubmit).toHaveBeenCalledWith({
      channelName: "general",
      serverName: "Agent Network",
      serverSlug: "agent-network",
      visibility: "public",
    });
  });

  it("keeps a manually edited slug when the Server name changes", async () => {
    const screen = await render(
      <FirstWorkspaceScreen
        onLogout={jest.fn()}
        onSubmit={jest.fn()}
      />,
    );

    await fireEvent.changeText(
      screen.getByLabelText("Server 名称"),
      "Agent Network",
    );
    await fireEvent.changeText(
      screen.getByLabelText("Server 标识"),
      "my-agents",
    );
    await fireEvent.changeText(
      screen.getByLabelText("Server 名称"),
      "新的名称",
    );

    expect(screen.getByLabelText("Server 标识").props.value).toBe(
      "my-agents",
    );
  });

  it("uses a deterministic valid fallback for a Chinese-only name", () => {
    const first = makeServerSlug("智能助手");

    expect(first).toMatch(/^server-[a-z0-9]{6}$/);
    expect(makeServerSlug("智能助手")).toBe(first);
  });

  it("stacks the setup panels on a compact viewport", async () => {
    const screen = await render(
      <FirstWorkspaceScreen
        onLogout={jest.fn()}
        onSubmit={jest.fn()}
        viewportWidth={390}
      />,
    );

    expect(screen.getByTestId("first-workspace-shell")).toHaveStyle({
      flexDirection: "column",
    });
  });

  it("publishes the same form state and actions through the semantic presenter", async () => {
    const onSubmit = jest.fn();
    let setup: WorkspaceSetupModel | undefined;
    const presenter: HumanClientPresenter = {
      kind: "terminal",
      renderConversationPage(_model, fallback) {
        return fallback;
      },
      renderManagementPage(_model, fallback) {
        return fallback;
      },
      renderWorkspaceSetup(model, fallback) {
        setup = model;
        return fallback;
      },
    };
    const screen = await render(
      <PresentationProvider presenter={presenter}>
        <FirstWorkspaceScreen
          onLogout={jest.fn()}
          onSubmit={onSubmit}
        />
      </PresentationProvider>,
    );

    expect(setup?.title).toBe("建立你的第一个 Server");
    expect(setup?.form.fields.map((field) => field.id)).toEqual([
      "server-name",
      "server-slug",
      "channel-name",
      "visibility",
    ]);

    await fireEvent.changeText(
      screen.getByLabelText("Server 名称"),
      "Agent Network",
    );
    await act(async () => {
      await setup?.form.actions.find((action) => action.id === "submit")?.run();
    });

    expect(onSubmit).toHaveBeenCalledWith({
      channelName: "general",
      serverName: "Agent Network",
      serverSlug: "agent-network",
      visibility: "public",
    });
  });
});
