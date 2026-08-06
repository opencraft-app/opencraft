import type { Message } from "@vela/client-core";
import { fireEvent, render } from "@testing-library/react-native";
import {Linking, Platform, StyleSheet as RNStyleSheet} from "react-native";

import { MessageList } from "@/ui";
import {velaTheme} from "@/ui";

const originalPlatformOS = Platform.OS;

afterEach(() => {
  Object.defineProperty(Platform, "OS", {
    configurable: true,
    value: originalPlatformOS,
  });
});

function message(overrides: Partial<Message>): Message {
  const text = overrides.text ?? "默认消息";
  return {
    content: { kind: "text", text },
    conversationId: "GROUPtopic-1",
    createdAt: "2026-07-31T10:00:00.000Z",
    delivery: { state: "sent" },
    direction: "incoming",
    id: "message-1",
    kind: "text",
    mentions: [],
    rawType: "TIMTextElem",
    reactions: [],
    read: { state: "unknown" },
    senderId: "human-1",
    senderName: "小林",
    text,
    ...overrides,
  };
}

function pressHandler(instance: {
  unstable_fiber: unknown;
}): () => unknown {
  let current = instance.unstable_fiber as
    | {
        memoizedProps?: {onPress?: unknown};
        return?: unknown;
      }
    | null;
  while (current) {
    if (typeof current.memoizedProps?.onPress === "function") {
      return current.memoizedProps.onPress as () => unknown;
    }
    current = current.return as typeof current;
  }
  throw new Error("找不到按钮 onPress");
}

describe("MessageList", () => {
  it("does not flash the empty conversation state while history initializes", async () => {
    const screen = await render(
      <MessageList
        conversationKey="channel:channel-1"
        historyCompleted
        initializing
        messages={[]}
        onLoadOlder={jest.fn()}
        onQuote={jest.fn()}
        onRetry={jest.fn()}
      />,
    );

    expect(screen.getByLabelText("正在加载消息历史")).toBeVisible();
    expect(screen.getByText("正在同步消息")).toBeVisible();
    expect(screen.queryByText("从这里开始协作")).toBeNull();
  });

  it("uses a bounded virtualized viewport for long conversations", async () => {
    const screen = await render(
      <MessageList
        conversationKey="channel:channel-1"
        historyCompleted
        messages={Array.from({ length: 120 }, (_, index) =>
          message({
            createdAt: `2026-07-31T10:${String(index % 60).padStart(2, "0")}:00.000Z`,
            id: `long-${index}`,
            text: `长会话消息 ${index}`,
          }),
        )}
        onLoadOlder={jest.fn()}
        onQuote={jest.fn()}
        onRetry={jest.fn()}
      />,
    );

    const viewport = screen.getByTestId("message-viewport");
    expect(viewport).toBeVisible();
    expect(viewport).toHaveProp("maintainVisibleContentPosition", {
      minIndexForVisible: 0,
    });
  });

  it("keeps loading older messages single-flight inside the viewport", async () => {
    let finishLoading: (() => void) | undefined;
    const onLoadOlder = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishLoading = resolve;
        }),
    );
    const screen = await render(
      <MessageList
        conversationKey="channel:channel-1"
        historyCompleted={false}
        messages={[message({id: "latest"})]}
        onLoadOlder={onLoadOlder}
        onQuote={jest.fn()}
        onRetry={jest.fn()}
      />,
    );

    const loadButton = screen.getByRole("button", {
      name: "加载更早消息",
    });
    const onPress = pressHandler(loadButton);
    onPress();
    onPress();

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    finishLoading?.();
    await Promise.resolve();
  });

  it("does not steal the viewport when a new message arrives during history reading", async () => {
    const first = message({id: "m1", text: "已有消息"});
    const screen = await render(
      <MessageList
        conversationKey="channel:channel-1"
        historyCompleted
        messages={[first]}
        onLoadOlder={jest.fn()}
        onQuote={jest.fn()}
        onRetry={jest.fn()}
      />,
    );

    await fireEvent.scroll(screen.getByTestId("message-viewport"), {
      nativeEvent: {
        contentOffset: {x: 0, y: 100},
        contentSize: {height: 1_200, width: 800},
        layoutMeasurement: {height: 400, width: 800},
      },
    });
    await screen.rerender(
      <MessageList
        conversationKey="channel:channel-1"
        historyCompleted
        messages={[
          first,
          message({
            createdAt: "2026-07-31T10:01:00.000Z",
            id: "m2",
            text: "刚收到的消息",
          }),
        ]}
        onLoadOlder={jest.fn()}
        onQuote={jest.fn()}
        onRetry={jest.fn()}
      />,
    );

    const newMessageButton = screen.getByRole("button", {
      name: "查看 1 条新消息",
    });
    expect(newMessageButton).toBeVisible();
    await fireEvent.press(newMessageButton);
    expect(
      screen.queryByRole("button", {name: "查看 1 条新消息"}),
    ).toBeNull();
  });

  it("groups consecutive sender rows and renders stable date separators", async () => {
    jest.useFakeTimers().setSystemTime(
      new Date("2026-08-01T12:00:00.000+08:00"),
    );
    const screen = await render(
      <MessageList
        conversationKey="channel:channel-1"
        historyCompleted
        messages={[
          message({ id: "m1", text: "第一条" }),
          message({
            createdAt: "2026-07-31T10:02:00.000Z",
            id: "m2",
            text: "连续回复",
          }),
          message({
            createdAt: "2026-08-01T10:00:00.000Z",
            id: "m3",
            senderId: "agent-1",
            senderName: "研究助手",
            text: "第二天回复",
          }),
        ]}
        onLoadOlder={jest.fn()}
        onQuote={jest.fn()}
        onRetry={jest.fn()}
      />,
    );

    expect(screen.getByTestId("date-2026-07-31")).toBeVisible();
    expect(screen.getByTestId("date-2026-08-01")).toBeVisible();
    expect(screen.getByText("昨天 · 7月31日")).toBeVisible();
    expect(screen.getByText("今天 · 8月1日")).toBeVisible();
    expect(screen.getAllByText("小林")).toHaveLength(1);
    expect(screen.getByText("连续回复")).toBeVisible();
    expect(screen.getByText("第二天回复")).toBeVisible();
    jest.useRealTimers();
  });

  it("keeps image messages media-first while exposing Vela message actions", async () => {
    const onQuote = jest.fn();
    const onCreateTask = jest.fn();
    const onOpenThread = jest.fn();
    const onToggleReaction = jest.fn();
    const image = message({
      content: {
        height: 900,
        kind: "image",
        name: "diagram.png",
        size: 456_789,
        url: "https://example.invalid/diagram.png",
        width: 1_600,
      },
      id: "image-1",
      kind: "image",
      reactions: [
        {
          count: 2,
          reactedByMe: true,
          reactionId: "👍",
        },
      ],
      text: "[图片]",
    });
    const screen = await render(
      <MessageList
        conversationKey="channel:channel-1"
        historyCompleted
        messages={[image]}
        onCreateTask={onCreateTask}
        onLoadOlder={jest.fn()}
        onOpenThread={onOpenThread}
        onQuote={onQuote}
        onRetry={jest.fn()}
        onToggleReaction={onToggleReaction}
      />,
    );

    expect(screen.getByLabelText("图片 diagram.png")).toBeVisible();
    expect(screen.queryByText("diagram.png")).toBeNull();
    expect(screen.queryByText("IMAGE")).toBeNull();
    expect(screen.queryByText("446.1 KB")).toBeNull();
    expect(screen.queryByText("引用")).toBeNull();
    await fireEvent(screen.getByTestId("message-image-1"), "longPress");
    await fireEvent.press(
      screen.getByRole("button", {
        name: "引用消息 [图片]",
      }),
    );
    expect(onQuote).toHaveBeenCalledWith("image-1");
    await fireEvent(screen.getByTestId("message-image-1"), "longPress");
    await fireEvent.press(
      screen.getByRole("button", {
        name: "Reaction 👍 2",
      }),
    );
    expect(onToggleReaction).toHaveBeenCalledWith("image-1", "👍");
    await fireEvent(screen.getByTestId("message-image-1"), "longPress");
    await fireEvent.press(
      screen.getByRole("button", {
        name: "将消息转为 Task [图片]",
      }),
    );
    expect(onCreateTask).toHaveBeenCalledWith("image-1");
    await fireEvent(screen.getByTestId("message-image-1"), "longPress");
    await fireEvent.press(
      screen.getByRole("button", {
        name: "在 Thread 回复 [图片]",
      }),
    );
    expect(onOpenThread).toHaveBeenCalledWith("image-1");
  });

  it("exposes a visible recall action only for an outgoing message", async () => {
    const onRevoke = jest.fn();
    const outgoing = message({
      direction: "outgoing",
      id: "outgoing-message-1",
      text: "请撤回这条",
    });
    const screen = await render(
      <MessageList
        {...({onRevoke} as Record<string, unknown>)}
        conversationKey="channel:channel-1"
        historyCompleted
        messages={[outgoing]}
        onLoadOlder={jest.fn()}
        onQuote={jest.fn()}
        onRetry={jest.fn()}
      />,
    );

    await fireEvent(screen.getByTestId("message-outgoing-message-1"), "longPress");
    await fireEvent.press(
      screen.getByRole("button", {name: "撤回消息 请撤回这条"}),
    );
    expect(onRevoke).toHaveBeenCalledWith("outgoing-message-1");
  });

  it("opens and closes an accessible full-screen image preview", async () => {
    const image = message({
      content: {
        height: 900,
        kind: "image",
        name: "diagram.png",
        size: 456_789,
        thumbnailUrl: "https://example.invalid/diagram-thumb.png",
        url: "https://example.invalid/diagram.png",
        width: 1_600,
      },
      id: "image-preview-1",
      kind: "image",
      text: "[图片]",
    });
    const screen = await render(
      <MessageList
        conversationKey="channel:channel-1"
        historyCompleted
        messages={[image]}
        onLoadOlder={jest.fn()}
        onQuote={jest.fn()}
        onRetry={jest.fn()}
      />,
    );

    expect(screen.queryByTestId("image-preview-modal")).toBeNull();
    await fireEvent.press(
      screen.getByRole("button", {name: "预览图片 diagram.png"}),
    );
    expect(screen.getByTestId("image-preview-modal")).toBeVisible();
    expect(screen.getByLabelText("图片预览 diagram.png")).toHaveProp(
      "source",
      {uri: "https://example.invalid/diagram.png"},
    );
    expect(screen.getByTestId("image-preview-modal")).toHaveProp(
      "onRequestClose",
      expect.any(Function),
    );

    await fireEvent.press(
      screen.getByRole("button", {name: "关闭图片预览"}),
    );
    expect(screen.queryByTestId("image-preview-modal")).toBeNull();
  });

  it("opens a file attachment from its message card", async () => {
    const openURL = jest
      .spyOn(Linking, "openURL")
      .mockResolvedValue(undefined);
    const file = message({
      content: {
        kind: "file",
        name: "spec.pdf",
        size: 1_048_576,
        url: "https://example.invalid/spec.pdf",
      },
      id: "file-1",
      kind: "file",
      text: "spec.pdf",
    });
    const screen = await render(
      <MessageList
        conversationKey="channel:channel-1"
        historyCompleted
        messages={[file]}
        onLoadOlder={jest.fn()}
        onQuote={jest.fn()}
        onRetry={jest.fn()}
      />,
    );

    expect(screen.getByText("FILE")).toHaveStyle({
      fontSize: velaTheme.semantic.typography.eyebrow.fontSize,
    });
    expect(screen.getByText("spec.pdf")).toBeVisible();
    expect(screen.getByText("1.0 MB")).toHaveStyle({
      fontSize: velaTheme.semantic.typography.meta.fontSize,
    });
    await fireEvent.press(
      screen.getByRole("link", {name: "打开文件 spec.pdf"}),
    );
    expect(openURL).toHaveBeenCalledWith(
      "https://example.invalid/spec.pdf",
    );
    openURL.mockRestore();
  });

  it("lets attachment cards shrink inside a 320px compact message row", async () => {
    const screen = await render(
      <MessageList
        conversationKey="channel:channel-1"
        historyCompleted
        messages={[
          message({
            content: {
              kind: "file",
              name: "协作规格说明.pdf",
              size: 1_048_576,
              url: "https://example.invalid/spec.pdf",
            },
            id: "file-compact",
            kind: "file",
            text: "协作规格说明.pdf",
          }),
        ]}
        onLoadOlder={jest.fn()}
        onQuote={jest.fn()}
        onRetry={jest.fn()}
        viewportWidth={320}
      />,
    );

    expect(
      screen.getByRole("link", {name: "打开文件 协作规格说明.pdf"}),
    ).toHaveStyle({minWidth: 0});
  });

  it("does not expose a non-HTTP attachment URL as an interactive link", async () => {
    const file = message({
      content: {
        kind: "file",
        name: "unsafe.html",
        url: "javascript:alert(1)",
      },
      id: "unsafe-file",
      kind: "file",
      text: "unsafe.html",
    });
    const screen = await render(
      <MessageList
        conversationKey="channel:channel-1"
        historyCompleted
        messages={[file]}
        onLoadOlder={jest.fn()}
        onQuote={jest.fn()}
        onRetry={jest.fn()}
      />,
    );

    expect(
      screen.queryByRole("link", {name: "打开文件 unsafe.html"}),
    ).toBeNull();
    expect(screen.getByText("unsafe.html")).toBeVisible();
  });

  it("reveals the desktop message action from its stable slot on row hover or focus", async () => {
    Object.defineProperty(Platform, "OS", {
      configurable: true,
      value: "web",
    });
    const screen = await render(
      <MessageList
        conversationKey="channel:channel-1"
        historyCompleted
        messages={[message({id: "visual-message", text: "整洁消息"})]}
        onLoadOlder={jest.fn()}
        onQuote={jest.fn()}
        onRetry={jest.fn()}
        viewportWidth={1_440}
      />,
    );

    expect(screen.getByTestId("message-avatar-visual-message")).toHaveStyle({
      borderRadius: 9999,
      height: velaTheme.recipes.identity.avatarCompactSize,
      width: velaTheme.recipes.identity.avatarCompactSize,
    });
    expect(screen.queryByText("引用")).toBeNull();
    expect(
      screen.getByRole("button", {name: "更多消息操作 整洁消息"}),
    ).toHaveStyle({height: 28, opacity: 0, width: 28});
    expect(screen.getByText("整洁消息")).toHaveStyle({
      fontSize: velaTheme.semantic.typography.messageBody.fontSize,
      lineHeight: velaTheme.semantic.typography.messageBody.lineHeight,
    });
    expect(screen.getByText("小林")).toHaveStyle({
      fontSize: velaTheme.semantic.typography.messageSender.fontSize,
    });
    expect(
      screen.getByTestId("message-timestamp-visual-message"),
    ).toHaveStyle({
      fontSize: velaTheme.semantic.typography.messageMeta.fontSize,
    });
    expect(screen.getByTestId("message-visual-message")).toHaveStyle({
      gap: velaTheme.recipes.conversationWorkspace.messageRowGap,
      paddingVertical: 8,
    });
    expect(
      screen.getByTestId("message-content-row-visual-message"),
    ).toHaveStyle({
      alignItems: "flex-start",
      flexDirection: "row",
    });
    expect(
      screen.getByRole("button", {name: "更多消息操作 整洁消息"}),
    ).not.toHaveStyle({position: "absolute", right: 0});
    await fireEvent(
      screen.getByTestId("message-visual-message"),
      "pointerEnter",
    );
    expect(
      screen.getByRole("button", {name: "更多消息操作 整洁消息"}),
    ).toHaveStyle({opacity: 1});
    await fireEvent(
      screen.getByTestId("message-visual-message"),
      "pointerLeave",
    );
    expect(
      screen.getByRole("button", {name: "更多消息操作 整洁消息"}),
    ).toHaveStyle({opacity: 0});
    await fireEvent(
      screen.getByRole("button", {name: "更多消息操作 整洁消息"}),
      "focus",
    );
    expect(
      screen.getByRole("button", {name: "更多消息操作 整洁消息"}),
    ).toHaveStyle({opacity: 1});
    await fireEvent.press(
      screen.getByRole("button", {name: "更多消息操作 整洁消息"}),
    );
    expect(
      screen.getByRole("button", {name: "更多消息操作 整洁消息"}),
    ).toHaveStyle({opacity: 1});
    expect(screen.getByTestId("message-actions-visual-message")).toHaveStyle({
      alignSelf: "flex-start",
      borderWidth: 1,
      paddingHorizontal: 6,
    });
    expect(
      screen.getByRole("button", {name: "添加 Reaction 👍"}),
    ).toHaveStyle({minHeight: velaTheme.recipes.control.height, minWidth: velaTheme.recipes.control.squareSize});
    expect(
      screen.getByRole("button", {name: "引用消息 整洁消息"}),
    ).toHaveStyle({minHeight: velaTheme.recipes.control.height, minWidth: velaTheme.recipes.control.squareSize});
    expect(screen.getByText("引用")).toHaveStyle({
      fontSize: velaTheme.semantic.typography.label.fontSize,
    });
  });

  it("makes message ownership and read state explicit in a direct conversation", async () => {
    const screen = await render(
      <MessageList
        conversationKey="direct:agent-im-1"
        historyCompleted
        messages={[
          message({
            direction: "outgoing",
            id: "direct-outgoing",
            read: {state: "read"},
            senderId: "human-1",
            senderName: "我",
            text: "我发出的消息",
          }),
          message({
            createdAt: "2026-07-31T10:03:00.000Z",
            direction: "incoming",
            id: "direct-incoming",
            senderId: "agent-1",
            senderName: "研究助手",
            text: "Agent 的回复",
          }),
        ]}
        onLoadOlder={jest.fn()}
        onQuote={jest.fn()}
        onRetry={jest.fn()}
        viewportWidth={1_440}
      />,
    );

    expect(screen.getByTestId("message-direct-outgoing")).toHaveStyle({
      flexDirection: "row-reverse",
    });
    expect(screen.getByTestId("message-body-direct-outgoing")).toHaveStyle({
      alignItems: "flex-end",
    });
    expect(screen.getByTestId("message-direct-incoming")).toHaveStyle({
      flexDirection: "row",
    });
    expect(screen.getByText("已读")).toBeVisible();
  });

  it("closes the message action menu after quoting", async () => {
    const onQuote = jest.fn();
    const screen = await render(
      <MessageList
        conversationKey="channel:channel-1"
        historyCompleted
        messages={[message({id: "quote-message", text: "需要引用"})]}
        onLoadOlder={jest.fn()}
        onQuote={onQuote}
        onRetry={jest.fn()}
      />,
    );

    await fireEvent(
      screen.getByTestId("message-quote-message"),
      "longPress",
    );
    await fireEvent.press(
      screen.getByRole("button", {
        name: "引用消息 需要引用",
      }),
    );

    expect(onQuote).toHaveBeenCalledWith("quote-message");
    expect(screen.queryByTestId("message-actions-quote-message")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "更多消息操作 需要引用",
      }),
    ).toHaveProp("accessibilityState", {expanded: false});
  });

  it("keeps one message action menu open and clears it for a new conversation", async () => {
    const messages = [
      message({id: "message-a", text: "第一条消息"}),
      message({id: "message-b", text: "第二条消息"}),
    ];
    const screen = await render(
      <MessageList
        conversationKey="channel:channel-1"
        historyCompleted
        messages={messages}
        onLoadOlder={jest.fn()}
        onQuote={jest.fn()}
        onRetry={jest.fn()}
      />,
    );

    await fireEvent(screen.getByTestId("message-message-a"), "longPress");
    expect(screen.getByTestId("message-actions-message-a")).toBeVisible();

    await fireEvent(screen.getByTestId("message-message-b"), "longPress");
    expect(screen.queryByTestId("message-actions-message-a")).toBeNull();
    expect(screen.getByTestId("message-actions-message-b")).toBeVisible();

    await screen.rerender(
      <MessageList
        conversationKey="channel:channel-2"
        historyCompleted
        messages={messages}
        onLoadOlder={jest.fn()}
        onQuote={jest.fn()}
        onRetry={jest.fn()}
      />,
    );
    expect(screen.queryByTestId("message-actions-message-b")).toBeNull();
  });

  it("keeps compact message actions discoverable while preserving long press", async () => {
    Object.defineProperty(Platform, "OS", {
      configurable: true,
      value: "web",
    });
    const screen = await render(
      <MessageList
        conversationKey="channel:channel-1"
        historyCompleted
        messages={[message({id: "compact-message", text: "触屏消息"})]}
        onLoadOlder={jest.fn()}
        onQuote={jest.fn()}
        onRetry={jest.fn()}
        viewportWidth={390}
      />,
    );

    const compactAction = screen.getByRole("button", {
      name: "更多消息操作 触屏消息",
    });
    expect(compactAction).toBeVisible();
    expect(compactAction).toHaveStyle({height: 32, opacity: 1, width: 32});
    expect(screen.queryByTestId("message-actions-compact-message")).toBeNull();
    await fireEvent.press(compactAction);
    expect(screen.getByTestId("message-actions-compact-message")).toBeVisible();
    await fireEvent.press(compactAction);
    expect(screen.queryByTestId("message-actions-compact-message")).toBeNull();
    await fireEvent(
      screen.getByTestId("message-compact-message"),
      "longPress",
    );
    expect(screen.getByTestId("message-actions-compact-message")).toBeVisible();
    expect(
      RNStyleSheet.flatten(
        screen.getByTestId("message-viewport").props.contentContainerStyle,
      ),
    ).toEqual(expect.objectContaining({paddingHorizontal: velaTheme.spacing.lg}));
    expect(screen.getByTestId("message-compact-message")).toHaveStyle({
      gap: 8,
    });
    expect(screen.getByTestId("message-avatar-compact-message")).toHaveStyle({
      borderRadius: 9999,
      height: velaTheme.recipes.identity.avatarRowSize,
      width: velaTheme.recipes.identity.avatarRowSize,
    });
  });

  it("lets task cards shrink inside a 320px compact message row", async () => {
    const screen = await render(
      <MessageList
        conversationKey="channel:channel-1"
        historyCompleted
        messages={[
          message({
            content: {
              kind: "task",
              status: "进行中",
              taskId: "task-compact",
              title: "首次协作闭环验收",
            },
            id: "task-compact-message",
            kind: "task",
            rawType: "VELA_TASK",
          }),
        ]}
        onLoadOlder={jest.fn()}
        onQuote={jest.fn()}
        onRetry={jest.fn()}
        viewportWidth={320}
      />,
    );

    expect(screen.getByTestId("message-task-card-task-compact-message")).toHaveStyle({
      minWidth: 0,
    });
  });

  it.each([320, 360])(
    "keeps four labeled message actions on one row at %ipx",
    async (viewportWidth) => {
      Object.defineProperty(Platform, "OS", {
        configurable: true,
        value: "web",
      });
      const screen = await render(
        <MessageList
          conversationKey="channel:channel-1"
          historyCompleted
          messages={[message({id: "narrow-actions", text: "窄屏消息"})]}
          onCreateTask={jest.fn()}
          onLoadOlder={jest.fn()}
          onOpenThread={jest.fn()}
          onQuote={jest.fn()}
          onRetry={jest.fn()}
          onToggleReaction={jest.fn()}
          viewportWidth={viewportWidth}
        />,
      );

      await fireEvent(
        screen.getByTestId("message-narrow-actions"),
        "longPress",
      );

      expect(screen.getByTestId("message-actions-narrow-actions")).toHaveStyle({
        flexWrap: "nowrap",
        gap: 2,
        paddingHorizontal: 4,
      });
      for (const name of [
        "添加 Reaction 👍",
        "引用消息 窄屏消息",
        "在 Thread 回复 窄屏消息",
        "将消息转为 Task 窄屏消息",
      ]) {
        expect(screen.getByRole("button", {name})).toHaveStyle({
          gap: 3,
          minHeight: velaTheme.recipes.control.height,
          minWidth: velaTheme.recipes.control.squareSize,
          paddingHorizontal: 4,
        });
      }
      expect(screen.getByText("表情")).toBeVisible();
      expect(screen.getByText("引用")).toBeVisible();
      expect(screen.getByText("回复")).toBeVisible();
      expect(screen.getByText("转任务")).toBeVisible();
    },
  );

  it("allows dynamic Reaction chips to wrap safely at 320px", async () => {
    Object.defineProperty(Platform, "OS", {
      configurable: true,
      value: "web",
    });
    const screen = await render(
      <MessageList
        conversationKey="channel:channel-1"
        historyCompleted
        messages={[
          message({
            id: "narrow-reactions",
            reactions: [
              {count: 2, reactedByMe: true, reactionId: "👍"},
              {count: 1, reactedByMe: false, reactionId: "🎉"},
            ],
            text: "有多个表情的窄屏消息",
          }),
        ]}
        onCreateTask={jest.fn()}
        onLoadOlder={jest.fn()}
        onOpenThread={jest.fn()}
        onQuote={jest.fn()}
        onRetry={jest.fn()}
        onToggleReaction={jest.fn()}
        viewportWidth={320}
      />,
    );

    await fireEvent(
      screen.getByTestId("message-narrow-reactions"),
      "longPress",
    );

    expect(screen.getByTestId("message-actions-narrow-reactions")).toHaveStyle({
      flexWrap: "wrap",
      gap: 2,
      paddingHorizontal: 4,
    });
  });

  it("opens native message actions by long press without a permanent ellipsis", async () => {
    Object.defineProperty(Platform, "OS", {
      configurable: true,
      value: "ios",
    });
    const screen = await render(
      <MessageList
        conversationKey="channel:channel-1"
        historyCompleted
        messages={[message({id: "native-message", text: "原生消息"})]}
        onLoadOlder={jest.fn()}
        onQuote={jest.fn()}
        onRetry={jest.fn()}
        viewportWidth={1_440}
      />,
    );

    expect(
      screen.queryByRole("button", {name: "更多消息操作 原生消息"}),
    ).toBeNull();
    await fireEvent(
      screen.getByTestId("message-native-message"),
      "longPress",
    );
    expect(screen.getByTestId("message-actions-native-message")).toBeVisible();
  });

  it("keeps the send result visible for an outgoing channel message", async () => {
    const screen = await render(
      <MessageList
        conversationKey="channel:channel-1"
        historyCompleted
        messages={[
          message({
            direction: "outgoing",
            id: "sent-message",
            read: {state: "unknown"},
            text: "已发送消息",
          }),
        ]}
        onLoadOlder={jest.fn()}
        onQuote={jest.fn()}
        onRetry={jest.fn()}
      />,
    );

    expect(screen.getByText("已发送")).toBeVisible();
  });

  it("renders an unavailable Thread reference without interactive message actions", async () => {
    const unavailable = message({
      content: {
        kind: "unsupported",
        rawType: "VELA_MESSAGE_UNAVAILABLE",
      },
      id: "missing-message-1",
      kind: "unsupported",
      rawType: "VELA_MESSAGE_UNAVAILABLE",
      text: "消息已不可用",
    });
    const screen = await render(
      <MessageList
        conversationKey="thread:thread-1"
        historyCompleted
        messages={[unavailable]}
        onCreateTask={jest.fn()}
        onLoadOlder={jest.fn()}
        onOpenThread={jest.fn()}
        onQuote={jest.fn()}
        onRetry={jest.fn()}
        onToggleReaction={jest.fn()}
      />,
    );

    expect(screen.getByText("消息已不可用")).toBeVisible();
    expect(screen.queryByLabelText("添加 Reaction 👍")).toBeNull();
    expect(screen.queryByLabelText("引用消息 消息已不可用")).toBeNull();
    expect(screen.queryByLabelText("在 Thread 回复 消息已不可用")).toBeNull();
    expect(screen.queryByLabelText("将消息转为 Task 消息已不可用")).toBeNull();
  });
});
