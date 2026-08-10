import {fireEvent, render} from "@testing-library/react-native";

import {StyleLabScreen, velaTheme} from "@/ui";

jest.mock("../../ui/components/composer-editor", () => {
  const React = require("react") as typeof import("react");
  const {TextInput} = require("react-native") as typeof import("react-native");
  const core = require("@vela/client-core") as typeof import("@vela/client-core");
  return {
    ComposerEditor: React.forwardRef(function MockComposerEditor(
      props: {
        disabled?: boolean;
        document: import("@vela/client-core").ComposerDocument;
        onSnapshotChange(value: unknown): void;
        onSubmit(value: unknown): void;
        placeholder: string;
      },
      ref: React.ForwardedRef<{
        focus(): void;
        replaceDocument(value: import("@vela/client-core").ComposerDocument): void;
        requestSubmit(): void;
      }>,
    ) {
      const [document, setDocument] = React.useState(props.document);
      const latest = React.useRef(document);
      latest.current = document;
      React.useImperativeHandle(ref, () => ({
        focus() {},
        replaceDocument(value) {
          latest.current = value;
          setDocument(value);
        },
        requestSubmit() {
          props.onSubmit({
            document: latest.current,
            selection: null,
            text: core.composerDocumentText(latest.current),
          });
        },
      }));
      return (
        <TextInput
          accessibilityLabel="消息内容"
          editable={!props.disabled}
          onChangeText={(text) => {
            const next = core.createComposerTextDocument(text);
            latest.current = next;
            setDocument(next);
            props.onSnapshotChange({document: next, selection: null, text});
          }}
          placeholder={props.placeholder}
          value={core.composerDocumentText(document)}
        />
      );
    }),
  };
});

describe("StyleLabScreen", () => {
  it("renders the approved desktop workspace fixture with production components", async () => {
    const screen = await render(<StyleLabScreen viewportWidth={1_180} />);

    expect(screen.getByTestId("style-lab-screen")).toBeVisible();
    expect(screen.getByTestId("conversation-sidebar")).toHaveStyle({
      width: 312,
    });
    expect(screen.getByText("产品实验室")).toBeVisible();
    expect(screen.getAllByText("general").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("首次协作闭环验收")).toBeVisible();
    expect(screen.getAllByText("Atlas Agent").length).toBeGreaterThan(0);
    expect(screen.getByPlaceholderText("发消息")).toBeVisible();
  });

  it("previews a DM without changing the Server-level Agent count", async () => {
    const screen = await render(<StyleLabScreen viewportWidth={1_180} />);

    await fireEvent.press(
      screen.getByRole("button", {name: "打开私信 Atlas Agent @atlas"}),
    );

    expect(screen.getByText("8 位成员 · 2 个 Agent")).toBeVisible();
    expect(screen.getByPlaceholderText("发消息")).toBeVisible();
    expect(
      screen.queryByRole("button", {name: "提及 Agent"}),
    ).toBeNull();
  });

  it("previews a distinct member count for each Channel", async () => {
    const screen = await render(<StyleLabScreen viewportWidth={1_180} />);

    expect(
      screen.getByRole("button", {
        name: "查看 Channel general 的 3 位成员",
      }),
    ).toBeVisible();

    await fireEvent.press(
      screen.getByRole("button", {name: "打开 Channel 产品讨论"}),
    );

    expect(
      screen.getByRole("button", {
        name: "查看 Channel 产品讨论 的 4 位成员",
      }),
    ).toBeVisible();
  });

  it("demonstrates that a public Channel has its own manageable member list", async () => {
    const screen = await render(<StyleLabScreen viewportWidth={1_180} />);

    await fireEvent.press(
      screen.getByRole("button", {
        name: "查看 Channel general 的 3 位成员",
      }),
    );

    expect(
      screen.getByText(
        "Server 成员可发现并自助加入；成员名单仍只属于这个 Channel。",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "移出 Channel Atlas Agent @atlas",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "添加 Channel Runtime Agent @runtime",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "添加 Channel 设计小组 @ux",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {name: "退出 Channel 林墨"}),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", {name: "打开私信 林墨 @linmo"}),
    ).toBeNull();
    expect(
      screen.getByRole("button", {name: "打开私信 周岚 @zhoulan"}),
    ).toBeVisible();
  });

  it("finds current and available Channel members by name or handle", async () => {
    const screen = await render(<StyleLabScreen viewportWidth={320} />);

    await fireEvent.press(
      screen.getByRole("button", {
        name: "查看 Channel general 的 3 位成员",
      }),
    );

    const search = screen.getByLabelText("搜索 Channel 成员");
    await fireEvent.changeText(search, "runtime");

    expect(screen.getByText("Runtime Agent")).toBeVisible();
    expect(screen.queryByText("Atlas Agent")).toBeNull();
    expect(screen.queryByText("设计小组")).toBeNull();

    await fireEvent.changeText(search, "linmo");
    expect(screen.getByText("林墨")).toBeVisible();
    expect(screen.queryByText("Runtime Agent")).toBeNull();

    await fireEvent.changeText(search, "不存在的人");
    expect(screen.getByText("没有匹配的成员或 Agent。")).toBeVisible();

    await fireEvent.press(
      screen.getByRole("button", {name: "清除成员搜索"}),
    );
    expect(screen.getByText("Atlas Agent")).toBeVisible();
    expect(screen.getByText("设计小组")).toBeVisible();
  });

  it("explains public discovery separately from private invitation", async () => {
    const screen = await render(<StyleLabScreen viewportWidth={1_180} />);

    await fireEvent.press(
      screen.getByRole("button", {name: "新建 Channel"}),
    );

    expect(
      screen.getByText("Server 成员可以发现并自助加入。"),
    ).toBeVisible();

    await fireEvent.press(
      screen.getByRole("radio", {name: "设为私密 Channel"}),
    );

    expect(
      screen.getByText("仅被添加的 Server 成员可以进入。"),
    ).toBeVisible();
  });

  it("keeps the image preview interaction available in the real-component lab", async () => {
    const screen = await render(<StyleLabScreen viewportWidth={1_180} />);

    await fireEvent.press(
      screen.getByRole("button", {name: "预览图片 协作拓扑.png"}),
    );
    expect(screen.getByTestId("image-preview-modal")).toBeVisible();
    expect(screen.getByLabelText("图片预览 协作拓扑.png")).toBeVisible();

    await fireEvent.press(
      screen.getByRole("button", {name: "关闭图片预览"}),
    );
    expect(screen.queryByTestId("image-preview-modal")).toBeNull();
  });

  it("previews management surfaces without leaving the visual lab", async () => {
    const screen = await render(<StyleLabScreen viewportWidth={980} />);

    expect(
      screen.getByRole("button", {name: "预览聊天界面"}),
    ).toBeVisible();
    await fireEvent.press(
      screen.getByRole("button", {name: "预览 Computer 界面"}),
    );

    expect(screen.getByTestId("computer-sidebar")).toHaveStyle({
      height: "100%",
      width: 312,
    });
    expect(screen.getByTestId("computer-stage-title")).toHaveTextContent(
      "Computer",
    );
    expect(screen.getByTestId("computer-detail")).toBeVisible();
    expect(screen.getAllByText("设计工作站").length).toBeGreaterThan(0);
    expect(screen.getByText("推理节点")).toBeVisible();
    await fireEvent.press(
      screen.getByRole("button", {name: "打开设计工作站终端"}),
    );
    expect(screen.getByTestId("computer-terminal-panel")).toBeVisible();
    expect(screen.getByText("终端已连接")).toBeVisible();

    await fireEvent.press(
      screen.getByRole("button", {name: "预览 Agent 界面"}),
    );
    await fireEvent.press(
      screen.getByRole("button", {name: "打开 Agent runtime"}),
    );
    expect(screen.getAllByText("待部署").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("编辑 Agent 显示名")).toHaveProp(
      "value",
      "Runtime Agent",
    );
    expect(
      screen.getByRole("radio", {name: "编辑 Runtime hermes-gateway"}),
    ).toHaveProp("accessibilityState", {checked: true, disabled: false});
    expect(
      screen.getByRole("combobox", {name: "Computer"}),
    ).toHaveProp("accessibilityState", {disabled: false, expanded: false});
    expect(
      screen.getByRole("button", {
        name: "轮换 Agent runtime 的运行凭证",
      }),
    ).toBeEnabled();
  });

  it("keeps the compact bottom navigation stable across preview tabs", async () => {
    // One WorkspaceChrome owns the bar. Section previews render framed={false}
    // so switching tabs must not remount nav or drop Settings.
    const screen = await render(<StyleLabScreen viewportWidth={390} />);

    await fireEvent.press(
      screen.getByRole("button", {name: "切换到 390px 手机画布"}),
    );

    const labels = () =>
      screen
        .getAllByTestId(/mobile-nav-item-/u)
        .map((node) => node.props.testID);

    expect(screen.getAllByTestId("mobile-bottom-nav")).toHaveLength(1);
    expect(labels()).toEqual([
      "mobile-nav-item-chat",
      "mobile-nav-item-tasks",
      "mobile-nav-item-agents",
      "mobile-nav-item-computers",
      "mobile-nav-item-members",
      "mobile-nav-item-settings",
    ]);

    await fireEvent.press(screen.getByRole("button", {name: "预览任务界面"}));
    expect(screen.getAllByTestId("mobile-bottom-nav")).toHaveLength(1);
    expect(labels()).toEqual([
      "mobile-nav-item-chat",
      "mobile-nav-item-tasks",
      "mobile-nav-item-agents",
      "mobile-nav-item-computers",
      "mobile-nav-item-members",
      "mobile-nav-item-settings",
    ]);
    expect(screen.getByRole("button", {name: "打开 Server 设置"})).toBeVisible();

    await fireEvent.press(screen.getByRole("button", {name: "预览 Agent 界面"}));
    expect(screen.getAllByTestId("mobile-bottom-nav")).toHaveLength(1);
    expect(labels()).toEqual([
      "mobile-nav-item-chat",
      "mobile-nav-item-tasks",
      "mobile-nav-item-agents",
      "mobile-nav-item-computers",
      "mobile-nav-item-members",
      "mobile-nav-item-settings",
    ]);
  });

  it("keeps every preview tab visible in a dedicated compact toolbar row", async () => {
    const screen = await render(<StyleLabScreen viewportWidth={390} />);

    expect(screen.getByTestId("style-lab-toolbar-content")).toHaveStyle({
      alignItems: "stretch",
      flexDirection: "column",
    });
    expect(screen.getByTestId("style-lab-preview-tabs")).toHaveStyle({
      minHeight: 36,
      width: "100%",
    });
    for (const label of [
      "预览聊天界面",
      "预览任务界面",
      "预览 Agent 界面",
      "预览 Computer 界面",
      "预览成员界面",
    ]) {
      expect(screen.getByRole("button", {name: label})).toHaveStyle({
        flex: 1,
        minWidth: 0,
      });
    }
  });

  it("switches the real-component canvas between review widths", async () => {
    const screen = await render(<StyleLabScreen viewportWidth={1_180} />);

    expect(screen.getByTestId("style-lab-canvas")).toHaveStyle({width: 1_180});
    expect(screen.getByText("真实组件 · 1180px 实时画布")).toBeVisible();

    await fireEvent.press(
      screen.getByRole("button", {name: "切换到 390px 手机画布"}),
    );

    expect(screen.getByTestId("style-lab-canvas")).toHaveStyle({width: 390});
    expect(screen.getByText("真实组件 · 390px 实时画布")).toBeVisible();

    await fireEvent.press(
      screen.getByRole("button", {name: "切换到 1440px 桌面画布"}),
    );

    expect(screen.getByTestId("style-lab-canvas")).toHaveStyle({width: 1_440});
    expect(screen.getByText("真实组件 · 1440px 实时画布")).toBeVisible();
    expect(
      screen.getByRole("button", {name: "切换到 1440px 桌面画布"}),
    ).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.selectionSurface,
      borderColor: velaTheme.semantic.color.borderSelected,
    });
  });

  it("covers normal, empty, disconnected, and unjoined review states", async () => {
    const screen = await render(<StyleLabScreen viewportWidth={1_180} />);

    for (const label of [
      "切换到正常状态",
      "切换到空状态",
      "切换到断线状态",
      "切换到未加入状态",
    ]) {
      expect(screen.getByRole("button", {name: label})).toBeVisible();
    }

    await fireEvent.press(
      screen.getByRole("button", {name: "切换到空状态"}),
    );
    expect(screen.getByText("从这里开始协作")).toBeVisible();

    await fireEvent.press(
      screen.getByRole("button", {name: "切换到断线状态"}),
    );
    expect(screen.getByText("消息连接已中断，请重新连接")).toBeVisible();

    await fireEvent.press(
      screen.getByRole("button", {name: "切换到未加入状态"}),
    );
    expect(screen.getByTestId("channel-join-empty-state")).toHaveStyle({
      alignItems: "flex-start",
    });
  });

  it("includes the 1024px desktop review breakpoint", async () => {
    const screen = await render(<StyleLabScreen viewportWidth={1_180} />);

    await fireEvent.press(
      screen.getByRole("button", {name: "切换到 1024px 桌面画布"}),
    );

    expect(screen.getByTestId("style-lab-canvas")).toHaveStyle({width: 1_024});
    expect(screen.getByText("真实组件 · 1024px 实时画布")).toBeVisible();
  });
});
