/** @jest-environment jsdom */

import {createComposerTextDocument} from "@vela/client-core";
import {act, createRef} from "react";
import {createRoot, type Root} from "react-dom/client";

import {
  LexicalComposerCore,
  type ComposerEditorHandle,
} from "./lexical-composer-core";

const appearance = {
  backgroundColor: "transparent",
  chipBackgroundColor: "#eef3ff",
  chipTextColor: "#3153a4",
  textLeading: 22,
  textSize: 15,
  typeface: "sans-serif",
  maxHeight: 200,
  minHeight: 48,
  paddingBottom: 10,
  paddingHorizontal: 12,
  paddingTop: 10,
  placeholderColor: "#777",
  textColor: "#111",
} as const;

describe("LexicalComposerCore", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("does not replace the document while an IME composition is active", async () => {
    const ref = createRef<ComposerEditorHandle>();
    const onSnapshotChange = jest.fn();
    await act(async () => {
      root.render(
        <LexicalComposerCore
          ref={ref}
          appearance={appearance}
          document={createComposerTextDocument("n")}
          onSnapshotChange={onSnapshotChange}
          onSubmit={jest.fn()}
          onSuggestionCommand={jest.fn()}
          placeholder="发消息"
          suggestionsOpen={false}
        />,
      );
    });

    const editable = container.querySelector<HTMLElement>(
      ".vela-composer-editor-input",
    );
    expect(editable).not.toBeNull();

    await act(async () => {
      editable!.dispatchEvent(
        new CompositionEvent("compositionstart", {bubbles: true, data: ""}),
      );
    });

    await act(async () => {
      root.render(
        <LexicalComposerCore
          ref={ref}
          appearance={appearance}
          document={createComposerTextDocument("")}
          onSnapshotChange={onSnapshotChange}
          onSubmit={jest.fn()}
          onSuggestionCommand={jest.fn()}
          placeholder="发消息"
          suggestionsOpen={false}
        />,
      );
    });

    expect(editable!.textContent).toContain("n");

    await act(async () => {
      editable!.dispatchEvent(
        new CompositionEvent("compositionend", {bubbles: true, data: "n"}),
      );
    });
  });

  it("inserts an immutable member mention and submits the structured document", async () => {
    const ref = createRef<ComposerEditorHandle>();
    const onSnapshotChange = jest.fn();
    const onSubmit = jest.fn();
    await act(async () => {
      root.render(
        <LexicalComposerCore
          ref={ref}
          appearance={appearance}
          document={createComposerTextDocument("请 @rese")}
          onSnapshotChange={onSnapshotChange}
          onSubmit={onSubmit}
          onSuggestionCommand={jest.fn()}
          placeholder="发消息"
          suggestionsOpen={false}
        />,
      );
    });

    await act(async () => {
      ref.current?.replaceMention({
        mention: {
          displayName: "研究助手",
          handle: "researcher",
          imUserId: "agent_im_1",
          memberId: "member-agent-1",
          memberKind: "agent",
          type: "mention",
        },
        trigger: {end: 7, query: "rese", start: 2},
      });
    });

    const chip = container.querySelector<HTMLElement>(".vela-composer-mention");
    expect(chip).not.toBeNull();
    expect(chip?.contentEditable).toBe("false");
    expect(chip?.textContent).toBe("@研究助手");

    await act(async () => ref.current?.requestSubmit());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        document: {
          nodes: [
            {text: "请 ", type: "text"},
            expect.objectContaining({
              imUserId: "agent_im_1",
              memberId: "member-agent-1",
              type: "mention",
            }),
            {text: " ", type: "text"},
          ],
          version: 1,
        },
        text: "请 @研究助手 ",
      }),
    );
  });

  it("reports focus from the real editable surface", async () => {
    const onFocus = jest.fn();
    await act(async () => {
      root.render(
        <LexicalComposerCore
          appearance={appearance}
          document={createComposerTextDocument("")}
          onFocus={onFocus}
          onSnapshotChange={jest.fn()}
          onSubmit={jest.fn()}
          onSuggestionCommand={jest.fn()}
          placeholder="发消息"
          suggestionsOpen={false}
        />,
      );
    });

    const editable = container.querySelector<HTMLElement>(
      ".vela-composer-editor-input",
    );
    await act(async () => editable?.focus());

    expect(onFocus).toHaveBeenCalledTimes(1);
  });
});
