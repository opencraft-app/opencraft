/** @jest-environment jsdom */

import {createComposerTextDocument} from "@vela/client-core";
import {act, createRef} from "react";
import {createRoot, type Root} from "react-dom/client";

import {
  LexicalComposerCore,
  type ComposerEditorHandle,
} from "./lexical-composer-core";

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

  it("inserts an immutable member mention and submits the structured document", async () => {
    const ref = createRef<ComposerEditorHandle>();
    const onSnapshotChange = jest.fn();
    const onSubmit = jest.fn();
    await act(async () => {
      root.render(
        <LexicalComposerCore
          ref={ref}
          appearance={{
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
          }}
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
});
