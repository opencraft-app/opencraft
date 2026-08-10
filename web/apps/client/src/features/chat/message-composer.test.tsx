import {
  composerDocumentText,
  createComposerDocument,
  createComposerTextDocument,
  type ComposerDraft,
} from "@vela/client-core";
import {fireEvent, render} from "@testing-library/react-native";
import {velaTheme} from "@/ui";

jest.mock("../../ui/components/composer-editor", () => {
  const React = require("react") as typeof import("react");
  const {TextInput} = require("react-native") as typeof import("react-native");
  const core = require("@vela/client-core") as typeof import("@vela/client-core");
  return {
    ComposerEditor: React.forwardRef(function MockComposerEditor(
      props: {
        disabled?: boolean;
        document: import("@vela/client-core").ComposerDocument;
        onFocus?(): void;
        onSnapshotChange(value: unknown): void;
        onSubmit(value: unknown): void;
        placeholder: string;
      },
      ref: React.ForwardedRef<{
        focus(): void;
        replaceDocument(value: import("@vela/client-core").ComposerDocument): void;
        replaceMention(value: import("../../ui/components/composer-editor/composer-editor.types").ComposerMentionInsertion): void;
        requestSubmit(): void;
      }>,
    ) {
      const [document, setDocument] = React.useState(props.document);
      const latest = React.useRef(document);
      latest.current = document;
      const publish = (next: import("@vela/client-core").ComposerDocument) => {
        latest.current = next;
        setDocument(next);
        props.onSnapshotChange({
          document: next,
          selection: null,
          text: core.composerDocumentText(next),
        });
      };
      React.useEffect(() => setDocument(props.document), [props.document]);
      React.useImperativeHandle(ref, () => ({
        focus() {},
        replaceDocument(value) {
          latest.current = value;
          setDocument(value);
        },
        replaceMention(value) {
          publish(core.createComposerDocument([
            ...latest.current.nodes,
            value.mention,
            {text: " ", type: "text"},
          ]));
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
          multiline
          onFocus={props.onFocus}
          onChangeText={(text) => publish(core.createComposerTextDocument(text))}
          placeholder={props.placeholder}
          value={core.composerDocumentText(document)}
        />
      );
    }),
  };
});

import {MessageComposer} from "./message-composer";

describe("MessageComposer", () => {
  it("renders the desktop composer as one integrated surface on the shared axis", async () => {
    const screen = await render(
      <MessageComposer
        channelName="general"
        members={[]}
        onSend={jest.fn()}
        surfaceMode="desktop"
      />,
    );

    expect(screen.getByTestId("composer-stage")).toHaveStyle({
      maxWidth: velaTheme.recipes.conversationWorkspace.composerDesktopMaxWidth,
      width: "100%",
    });
    expect(screen.getByTestId("message-composer")).toHaveStyle({
      bottom: 0,
      left: 0,
      paddingTop: 0,
      position: "absolute",
      right: 0,
    });
    expect(screen.getByTestId("message-composer-surface")).toHaveStyle({
      borderRadius:
        velaTheme.recipes.conversationWorkspace.composerSurfaceMetrics.desktop
          .radius,
      minHeight:
        velaTheme.recipes.conversationWorkspace.composerSurfaceMetrics.desktop
          .surfaceMinHeight,
      width: "100%",
    });
    expect(screen.getByTestId("composer-footer")).toBeVisible();
    expect(screen.getByRole("button", {name: "发送消息"})).toHaveStyle({
      height:
        velaTheme.recipes.conversationWorkspace.composerPrimaryActionSize,
      width: velaTheme.recipes.conversationWorkspace.composerPrimaryActionSize,
    });
  });

  it("reports the desktop overlay height to the message viewport", async () => {
    const onHeightChange = jest.fn();
    const screen = await render(
      <MessageComposer
        channelName="general"
        members={[]}
        onHeightChange={onHeightChange}
        onSend={jest.fn()}
        surfaceMode="desktop"
      />,
    );

    fireEvent(screen.getByTestId("message-composer"), "layout", {
      nativeEvent: {layout: {height: 124, width: 960, x: 0, y: 0}},
    });

    expect(onHeightChange).toHaveBeenCalledWith(124);
  });

  it.each(["compact", "native"] as const)(
    "keeps the %s composer surface full width",
    async (surfaceMode) => {
      const screen = await render(
        <MessageComposer
          channelName="general"
          members={[]}
          onSend={jest.fn()}
          surfaceMode={surfaceMode}
        />,
      );

      expect(screen.getByTestId("composer-stage")).toHaveStyle({
        maxWidth: "100%",
        width: "100%",
      });
    },
  );

  it("stages attachments and submits one structured product action", async () => {
    const onSend = jest.fn();
    const screen = await render(
      <MessageComposer
        channelName="general"
        members={[]}
        onAttachFile={jest.fn(async () => ({
          kind: "uri" as const,
          mimeType: "application/pdf",
          name: "spec.pdf",
          size: 1_024,
          uri: "file:///spec.pdf",
        }))}
        onSend={onSend}
        surfaceMode="desktop"
      />,
    );

    await fireEvent.press(screen.getByRole("button", {name: "添加文件"}));
    await fireEvent.changeText(screen.getByLabelText("消息内容"), "请一起查看");
    await fireEvent.press(screen.getByRole("button", {name: "发送消息"}));

    expect(onSend).toHaveBeenCalledWith({
      attachments: [
        expect.objectContaining({kind: "file", name: "spec.pdf", size: 1_024}),
      ],
      document: createComposerTextDocument("请一起查看"),
    });
    expect(screen.getByLabelText("消息内容")).toHaveProp("value", "");
  });

  it("keeps quote metadata on the submitted draft", async () => {
    const onSend = jest.fn();
    const quote = {
      messageId: "message-1",
      preview: "先核对接口。",
      senderId: "human-2",
      senderName: "小林",
    };
    const screen = await render(
      <MessageComposer
        channelName="general"
        members={[]}
        onClearQuote={jest.fn()}
        onSend={onSend}
        quote={quote}
        surfaceMode="desktop"
      />,
    );
    await fireEvent.changeText(screen.getByLabelText("消息内容"), "收到");
    await fireEvent.press(screen.getByRole("button", {name: "发送消息"}));
    expect(onSend).toHaveBeenCalledWith({
      attachments: [],
      document: createComposerTextDocument("收到"),
      quote,
    });
  });

  it("inserts an immutable Human or Agent mention from the same picker", async () => {
    const onSend = jest.fn();
    const screen = await render(
      <MessageComposer
        channelName="general"
        members={[
          {displayName: "小林", handle: "lin", id: "member-1", imUserId: "human-1", kind: "human"},
          {displayName: "研究助手", handle: "research", id: "member-2", imUserId: "agent-1", kind: "agent"},
        ]}
        onSend={onSend}
        surfaceMode="desktop"
      />,
    );
    await fireEvent.press(screen.getByRole("button", {name: "提及成员"}));
    expect(screen.getByTestId("mention-suggestions")).toHaveStyle({
      bottom: "100%",
      marginBottom: velaTheme.spacing.sm,
    });
    expect(screen.getByText("成员")).toBeVisible();
    expect(screen.getByText("Agent")).toBeVisible();
    await fireEvent.press(screen.getByRole("button", {name: "@研究助手"}));
    await fireEvent.press(screen.getByRole("button", {name: "发送消息"}));
    const draft = onSend.mock.calls[0]?.[0];
    expect(composerDocumentText(draft.document)).toBe("@研究助手 ");
    expect(draft.document.nodes).toEqual([
      expect.objectContaining({memberId: "member-2", type: "mention"}),
      {text: " ", type: "text"},
    ]);
  });

  it("hides mention controls for direct conversations with no candidates", async () => {
    const screen = await render(
      <MessageComposer
        channelName="私信"
        members={[]}
        onSend={jest.fn()}
        surfaceMode="desktop"
      />,
    );
    expect(screen.queryByRole("button", {name: "提及成员"})).toBeNull();
  });

  it("restores a structured external draft", async () => {
    const draft: ComposerDraft = {
      attachments: [],
      document: createComposerDocument([
        {text: "继续 ", type: "text"},
        {
          displayName: "研究助手",
          handle: "research",
          imUserId: "agent-1",
          memberId: "member-2",
          memberKind: "agent",
          type: "mention",
        },
      ]),
    };
    const screen = await render(
      <MessageComposer
        channelName="general"
        draft={draft}
        members={[]}
        onSend={jest.fn()}
        surfaceMode="desktop"
      />,
    );
    expect(screen.getByLabelText("消息内容")).toHaveProp(
      "value",
      "继续 @研究助手",
    );
  });

  it.each([
    ["desktop", "发送消息到 #general，输入 @ 提及成员"],
    ["compact", "发消息"],
    ["native", "发消息"],
  ] as const)("uses the %s composer copy", async (surfaceMode, placeholder) => {
    const screen = await render(
      <MessageComposer
        channelName="general"
        members={[]}
        onSend={jest.fn()}
        surfaceMode={surfaceMode}
      />,
    );

    expect(screen.getByLabelText("消息内容")).toHaveProp(
      "placeholder",
      placeholder,
    );
  });

  it("notifies the host when the real editor receives focus", async () => {
    const onFocus = jest.fn();
    const screen = await render(
      <MessageComposer
        channelName="general"
        members={[]}
        onFocus={onFocus}
        onSend={jest.fn()}
        surfaceMode="desktop"
      />,
    );

    await fireEvent(screen.getByLabelText("消息内容"), "focus");

    expect(onFocus).toHaveBeenCalledTimes(1);
  });
});
