import {
  composerDocumentText,
  createComposerDocument,
  createComposerTextDocument,
  type ComposerDraft,
} from "@vela/client-core";
import {fireEvent, render} from "@testing-library/react-native";

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
        viewportWidth={1_440}
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
      />,
    );
    await fireEvent.press(screen.getByRole("button", {name: "提及成员"}));
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
      <MessageComposer channelName="私信" members={[]} onSend={jest.fn()} />,
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
      />,
    );
    expect(screen.getByLabelText("消息内容")).toHaveProp(
      "value",
      "继续 @研究助手",
    );
  });
});
