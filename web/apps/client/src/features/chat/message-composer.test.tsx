import { act, fireEvent, render } from "@testing-library/react-native";
import { Platform } from "react-native";

import { MessageComposer } from "./message-composer";

const originalPlatformOS = Platform.OS;

afterEach(() => {
  Object.defineProperty(Platform, "OS", {
    configurable: true,
    value: originalPlatformOS,
  });
});

function useWebKeyboard(): void {
  Object.defineProperty(Platform, "OS", {
    configurable: true,
    value: "web",
  });
}

describe("MessageComposer", () => {
  it("shows and clears the selected quote before sending", async () => {
    const onClearQuote = jest.fn();
    const screen = await render(
      <MessageComposer
        agents={[]}
        channelName="general"
        onClearQuote={onClearQuote}
        onSend={jest.fn()}
        quote={{
          messageId: "message-1",
          preview: "先核对接口。",
          senderId: "human-2",
          senderName: "小林",
        }}
      />,
    );

    expect(screen.getByText("引用 小林")).toBeVisible();
    expect(screen.getByText("先核对接口。")).toBeVisible();
    await fireEvent.press(screen.getByRole("button", { name: "取消引用" }));

    expect(onClearQuote).toHaveBeenCalledTimes(1);
  });

  it("keeps the compact composer on one row and reveals attachments on demand", async () => {
    const onAttachImage = jest.fn();
    const onAttachFile = jest.fn();
    const screen = await render(
      <MessageComposer
        agents={[]}
        channelName="general"
        onAttachFile={onAttachFile}
        onAttachImage={onAttachImage}
        onSend={jest.fn()}
        viewportWidth={390}
      />,
    );

    expect(screen.getByLabelText("消息内容")).toBeVisible();
    expect(screen.getByTestId("message-composer")).toHaveStyle({
      borderBottomWidth: 0,
      borderLeftWidth: 0,
      borderRadius: 0,
      borderRightWidth: 0,
      borderTopWidth: 1,
      marginBottom: 0,
      marginHorizontal: 0,
      minHeight: 64,
    });
    expect(screen.getByTestId("composer-control-row")).toHaveStyle({
      alignItems: "center",
      flexDirection: "row",
    });
    expect(screen.getByLabelText("消息内容")).toHaveStyle({
      flex: 1,
      fontSize: 16,
      height: 44,
      minWidth: 0,
    });
    expect(screen.getByPlaceholderText("给 #general 发消息")).toBeVisible();
    expect(screen.queryByRole("button", {name: "添加文件"})).toBeNull();
    expect(screen.queryByRole("button", {name: "添加图片"})).toBeNull();
    expect(screen.getByRole("button", {name: "打开附件选项"})).toHaveStyle({
      height: 44,
      width: 44,
    });
    expect(screen.getByRole("button", { name: "发送消息" })).toHaveStyle({
      height: 44,
      paddingHorizontal: 0,
      width: 44,
    });
    expect(screen.queryByText("⌕")).toBeNull();
    expect(screen.queryByText("▧")).toBeNull();

    await fireEvent.press(
      screen.getByRole("button", {name: "打开附件选项"}),
    );
    expect(screen.getByTestId("attachment-picker")).toBeVisible();
    expect(screen.getByText("图片")).toBeVisible();
    expect(screen.getByText("文件")).toBeVisible();
    await fireEvent.press(screen.getByRole("button", { name: "添加图片" }));
    expect(screen.queryByTestId("attachment-picker")).toBeNull();
    await fireEvent.press(
      screen.getByRole("button", {name: "打开附件选项"}),
    );
    await fireEvent.press(screen.getByRole("button", { name: "添加文件" }));

    expect(onAttachImage).toHaveBeenCalledTimes(1);
    expect(onAttachFile).toHaveBeenCalledTimes(1);
  });

  it("keeps the empty composer prompt on one line at 320px", async () => {
    const screen = await render(
      <MessageComposer
        agents={[]}
        channelName="general"
        onSend={jest.fn()}
        viewportWidth={320}
      />,
    );

    expect(screen.getByPlaceholderText("发消息")).toBeVisible();
    expect(screen.getByLabelText("消息内容")).toHaveProp(
      "accessibilityHint",
      "发送到 #general",
    );
  });

  it("keeps the compact attachment and Agent pickers mutually exclusive", async () => {
    const screen = await render(
      <MessageComposer
        agents={[
          {
            displayName: "研究助手",
            id: "agent-1",
            imUserId: "agent_im_1",
          },
        ]}
        channelName="general"
        onSend={jest.fn()}
        viewportWidth={390}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", {name: "打开附件选项"}),
    );
    expect(screen.getByTestId("attachment-picker")).toBeVisible();

    await fireEvent.press(screen.getByRole("button", {name: "提及 Agent"}));
    expect(screen.queryByTestId("attachment-picker")).toBeNull();
    expect(screen.getByRole("button", {name: "@研究助手"})).toBeVisible();

    await fireEvent.press(
      screen.getByRole("button", {name: "打开附件选项"}),
    );
    expect(screen.getByTestId("attachment-picker")).toBeVisible();
    expect(screen.queryByRole("button", {name: "@研究助手"})).toBeNull();
  });

  it("docks the desktop composer into the workspace while preserving touch targets", async () => {
    const screen = await render(
      <MessageComposer
        agents={[]}
        channelName="general"
        onSend={jest.fn()}
        viewportWidth={1_440}
      />,
    );

    expect(screen.getByTestId("message-composer")).toHaveStyle({
      borderBottomWidth: 0,
      borderLeftWidth: 0,
      borderRadius: 0,
      borderRightWidth: 0,
      borderTopWidth: 1,
      marginBottom: 0,
      marginHorizontal: 0,
      minHeight: 72,
      paddingHorizontal: 16,
      paddingVertical: 12,
    });
    expect(screen.getByTestId("composer-control-row")).toHaveStyle({
      alignItems: "center",
      flexDirection: "row",
    });
    expect(screen.getByLabelText("消息内容")).toHaveStyle({
      flex: 1,
      height: 44,
    });
    expect(screen.getByRole("button", {name: "添加文件"})).toHaveStyle({
      height: 44,
      width: 44,
    });
  });

  it("grows a multiline draft to a bounded height and collapses after clearing", async () => {
    const screen = await render(
      <MessageComposer
        agents={[]}
        channelName="general"
        onSend={jest.fn()}
      />,
    );
    const input = screen.getByLabelText("消息内容");

    expect(input).toHaveStyle({ height: 44, maxHeight: 112 });
    expect(input).toHaveProp("onContentSizeChange", expect.any(Function));

    await fireEvent(input, "contentSizeChange", {
      nativeEvent: { contentSize: { height: 88, width: 320 } },
    });
    expect(screen.getByLabelText("消息内容")).toHaveStyle({ height: 88 });

    await fireEvent(input, "contentSizeChange", {
      nativeEvent: { contentSize: { height: 180, width: 320 } },
    });
    expect(screen.getByLabelText("消息内容")).toHaveStyle({ height: 112 });

    await fireEvent.changeText(input, "");
    expect(screen.getByLabelText("消息内容")).toHaveStyle({ height: 44 });
  });

  it("collapses when a controlled conversation draft is cleared externally", async () => {
    const onSend = jest.fn();
    const screen = await render(
      <MessageComposer
        agents={[]}
        channelName="general"
        draft={"第一行\n第二行\n第三行\n第四行\n第五行"}
        onSend={onSend}
      />,
    );
    const input = screen.getByLabelText("消息内容");

    await fireEvent(input, "contentSizeChange", {
      nativeEvent: { contentSize: { height: 180, width: 320 } },
    });
    expect(screen.getByLabelText("消息内容")).toHaveStyle({ height: 112 });

    await screen.rerender(
      <MessageComposer
        agents={[]}
        channelName="general"
        draft=""
        onSend={onSend}
      />,
    );
    expect(screen.getByLabelText("消息内容")).toHaveStyle({ height: 44 });
  });

  it("shows an explicit confirmation when an Agent mention is selected", async () => {
    const screen = await render(
      <MessageComposer
        agents={[
          {
            displayName: "研究助手",
            id: "agent-1",
            imUserId: "agent_im_1",
          },
        ]}
        channelName="general"
        onSend={jest.fn()}
      />,
    );

    await fireEvent.press(screen.getByRole("button", { name: "提及 Agent" }));
    expect(screen.queryByTestId("mention-selected-icon-agent-1")).toBeNull();

    await fireEvent.press(screen.getByRole("button", { name: "@研究助手" }));

    expect(screen.getByTestId("mention-selected-icon-agent-1")).toBeVisible();
    expect(screen.getByRole("button", { name: "@研究助手" })).toHaveProp(
      "accessibilityState",
      {selected: true},
    );
  });

  it("submits selected Agents as real IM mention targets", async () => {
    const onSend = jest.fn();
    const screen = await render(
      <MessageComposer
        agents={[
          {
            displayName: "研究助手",
            id: "agent-1",
            imUserId: "agent_im_1",
          },
        ]}
        channelName="general"
        onSend={onSend}
      />,
    );

    expect(screen.queryByRole("button", { name: "@研究助手" })).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "提及 Agent" }));
    expect(screen.getByRole("button", { name: "提及 Agent" })).toHaveStyle({
      height: 44,
      width: 44,
    });
    expect(screen.getByRole("button", { name: "@研究助手" })).toHaveStyle({
      minHeight: 44,
    });
    await fireEvent.press(screen.getByRole("button", { name: "@研究助手" }));
    await fireEvent.changeText(
      screen.getByPlaceholderText("给 #general 发消息"),
      "请总结今天的讨论。",
    );
    await fireEvent.press(screen.getByRole("button", { name: "发送消息" }));

    expect(onSend).toHaveBeenCalledWith({
      mentionedUserIds: ["agent_im_1"],
      text: "@研究助手 请总结今天的讨论。",
    });
    expect(screen.getByTestId("composer-icon-send")).toBeVisible();
  });

  it("keeps typing local and persists the conversation draft only on blur or send", async () => {
    const onDraftChange = jest.fn();
    const onSend = jest.fn();
    const screen = await render(
      <MessageComposer
        agents={[]}
        channelName="general"
        draft="还没发完的方案"
        onDraftChange={onDraftChange}
        onSend={onSend}
      />,
    );

    expect(screen.getByLabelText("消息内容")).toHaveProp(
      "value",
      "还没发完的方案",
    );

    await fireEvent.changeText(
      screen.getByLabelText("消息内容"),
      "补充后的方案",
    );
    expect(screen.getByLabelText("消息内容")).toHaveProp(
      "value",
      "补充后的方案",
    );
    expect(onDraftChange).not.toHaveBeenCalled();

    await fireEvent(screen.getByLabelText("消息内容"), "blur");
    expect(onDraftChange).toHaveBeenCalledWith("补充后的方案");

    await fireEvent.press(screen.getByRole("button", { name: "发送消息" }));
    expect(onSend).toHaveBeenCalledWith({
      mentionedUserIds: [],
      text: "补充后的方案",
    });
    expect(onDraftChange).toHaveBeenLastCalledWith("");
  });

  it("sends a desktop Web message with Enter and prevents a newline", async () => {
    useWebKeyboard();
    const onSend = jest.fn(async () => undefined);
    const preventDefault = jest.fn();
    const screen = await render(
      <MessageComposer
        agents={[]}
        channelName="general"
        onSend={onSend}
      />,
    );
    const input = screen.getByLabelText("消息内容");
    await fireEvent.changeText(input, "键盘发送");

    await fireEvent(input, "keyPress", {
      nativeEvent: {
        isComposing: false,
        key: "Enter",
        keyCode: 13,
        shiftKey: false,
      },
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith({
      mentionedUserIds: [],
      text: "键盘发送",
    });
    expect(input).toHaveProp("value", "");
  });

  it("keeps Shift+Enter as a desktop newline without sending", async () => {
    useWebKeyboard();
    const onSend = jest.fn();
    const preventDefault = jest.fn();
    const screen = await render(
      <MessageComposer
        agents={[]}
        channelName="general"
        onSend={onSend}
      />,
    );
    const input = screen.getByLabelText("消息内容");
    await fireEvent.changeText(input, "第一行");
    await fireEvent(input, "keyPress", {
      nativeEvent: {
        isComposing: false,
        key: "Enter",
        keyCode: 13,
        shiftKey: true,
      },
      preventDefault,
    });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each([
    {isComposing: true, keyCode: 13, label: "composition"},
    {isComposing: false, keyCode: 229, label: "IME keyCode"},
  ])("does not send Enter during $label", async ({isComposing, keyCode}) => {
    useWebKeyboard();
    const onSend = jest.fn();
    const preventDefault = jest.fn();
    const screen = await render(
      <MessageComposer
        agents={[]}
        channelName="general"
        onSend={onSend}
      />,
    );
    const input = screen.getByLabelText("消息内容");
    await fireEvent.changeText(input, "正在输入中文");
    await fireEvent(input, "keyPress", {
      nativeEvent: {
        isComposing,
        key: "Enter",
        keyCode,
        shiftKey: false,
      },
      preventDefault,
    });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not apply the Web Enter shortcut to native multiline input", async () => {
    Object.defineProperty(Platform, "OS", {
      configurable: true,
      value: "ios",
    });
    const onSend = jest.fn();
    const preventDefault = jest.fn();
    const screen = await render(
      <MessageComposer
        agents={[]}
        channelName="general"
        onSend={onSend}
      />,
    );
    const input = screen.getByLabelText("消息内容");
    await fireEvent.changeText(input, "移动端多行输入");
    await fireEvent(input, "keyPress", {
      nativeEvent: {key: "Enter"},
      preventDefault,
    });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("fences repeated Enter presses while the first send is pending", async () => {
    useWebKeyboard();
    let resolveSend: (() => void) | undefined;
    const onSend = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const screen = await render(
      <MessageComposer
        agents={[]}
        channelName="general"
        onSend={onSend}
      />,
    );
    const input = screen.getByLabelText("消息内容");
    await fireEvent.changeText(input, "只发送一次");
    const enter = {
      nativeEvent: {
        isComposing: false,
        key: "Enter",
        keyCode: 13,
        shiftKey: false,
      },
      preventDefault: jest.fn(),
    };

    const firstSend = input.props.onKeyPress(enter);
    const secondSend = input.props.onKeyPress(enter);

    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSend?.();
      await Promise.all([firstSend, secondSend]);
    });
    expect(input).toHaveProp("value", "");
  });
});
