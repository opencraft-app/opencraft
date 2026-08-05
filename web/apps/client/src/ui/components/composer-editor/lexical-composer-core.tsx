import {
  composerDocumentText,
  createComposerDocument,
  replaceComposerDocumentRangeWithMention,
  type ComposerDocument,
  type ComposerNode,
} from "@vela/client-core";
import {LexicalComposer} from "@lexical/react/LexicalComposer";
import {useLexicalComposerContext} from "@lexical/react/LexicalComposerContext";
import {ContentEditable} from "@lexical/react/LexicalContentEditable";
import {LexicalErrorBoundary} from "@lexical/react/LexicalErrorBoundary";
import {HistoryPlugin} from "@lexical/react/LexicalHistoryPlugin";
import {OnChangePlugin} from "@lexical/react/LexicalOnChangePlugin";
import {PlainTextPlugin} from "@lexical/react/LexicalPlainTextPlugin";
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type EditorState,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type CSSProperties,
  type ForwardedRef,
} from "react";

import {
  $createComposerMentionNode,
  $isComposerMentionNode,
  ComposerMentionNode,
} from "./composer-mention-node";
import type {
  ComposerEditorHandle,
  ComposerEditorProps,
  ComposerEditorSnapshot,
  ComposerSuggestionCommand,
} from "./composer-editor.types";

export type {ComposerEditorHandle} from "./composer-editor.types";

export const LexicalComposerCore = forwardRef<
  ComposerEditorHandle,
  ComposerEditorProps
>(function LexicalComposerCore(
  {
    appearance,
    disabled = false,
    document: externalDocument,
    onSnapshotChange,
    onSubmit,
    onSuggestionCommand,
    placeholder,
    suggestionsOpen,
  },
  ref,
) {
  const initialDocument = useRef(externalDocument);
  const initialEditable = useRef(!disabled);
  const config = useMemo(
    () => ({
      editable: initialEditable.current,
      editorState: () => replaceRootDocument(initialDocument.current),
      namespace: "VelaChatComposer",
      nodes: [ComposerMentionNode],
      onError(error: Error) {
        throw error;
      },
    }),
    [],
  );
  const variables = {
    "--vela-composer-chip-background": appearance.chipBackgroundColor,
    "--vela-composer-chip-text": appearance.chipTextColor,
  } as CSSProperties;

  return (
    <div
      className="vela-composer-editor-frame"
      style={{
        ...variables,
        background: appearance.backgroundColor,
        boxSizing: "border-box",
        maxHeight: appearance.maxHeight,
        minHeight: appearance.minHeight,
        position: "relative",
        width: "100%",
      }}
    >
      <style>{EDITOR_CSS}</style>
      <LexicalComposer initialConfig={config}>
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              aria-label="消息内容"
              aria-multiline="true"
              className="vela-composer-editor-input"
              spellCheck
              style={editorStyle(appearance)}
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
          placeholder={
            <div
              aria-hidden="true"
              className="vela-composer-editor-placeholder"
              style={{
                color: appearance.placeholderColor,
                ["fontFamily"]: appearance.typeface,
                ["fontSize"]: appearance.textSize,
                left: appearance.paddingHorizontal,
                ["lineHeight"]: `${appearance.textLeading}px`,
                pointerEvents: "none",
                position: "absolute",
                right: appearance.paddingHorizontal,
                top: appearance.paddingTop,
              }}
            >
              {placeholder}
            </div>
          }
        />
        <HistoryPlugin />
        <ComposerEditorBridge
          disabled={disabled}
          externalDocument={externalDocument}
          forwardedRef={ref}
          onSnapshotChange={onSnapshotChange}
          onSubmit={onSubmit}
          onSuggestionCommand={onSuggestionCommand}
          suggestionsOpen={suggestionsOpen}
        />
      </LexicalComposer>
    </div>
  );
});

function ComposerEditorBridge({
  disabled,
  externalDocument,
  forwardedRef,
  onSnapshotChange,
  onSubmit,
  onSuggestionCommand,
  suggestionsOpen,
}: {
  disabled: boolean;
  externalDocument: ComposerDocument;
  forwardedRef: ForwardedRef<ComposerEditorHandle>;
  onSnapshotChange: ComposerEditorProps["onSnapshotChange"];
  onSubmit: ComposerEditorProps["onSubmit"];
  onSuggestionCommand: ComposerEditorProps["onSuggestionCommand"];
  suggestionsOpen: boolean;
}) {
  const [editor] = useLexicalComposerContext();
  const externalKey = documentKey(externalDocument);
  const latestDocumentKey = useRef(externalKey);
  const onSnapshotChangeRef = useRef(onSnapshotChange);
  const onSubmitRef = useRef(onSubmit);
  const onSuggestionCommandRef = useRef(onSuggestionCommand);
  const suggestionsOpenRef = useRef(suggestionsOpen);
  onSnapshotChangeRef.current = onSnapshotChange;
  onSubmitRef.current = onSubmit;
  onSuggestionCommandRef.current = onSuggestionCommand;
  suggestionsOpenRef.current = suggestionsOpen;

  useEffect(() => editor.setEditable(!disabled), [disabled, editor]);
  useEffect(() => {
    if (externalKey === latestDocumentKey.current) return;
    editor.update(
      () => {
        replaceRootDocument(externalDocument);
        $getRoot().selectEnd();
      },
      {discrete: true},
    );
    latestDocumentKey.current = externalKey;
  }, [editor, externalDocument, externalKey]);

  useEffect(
    () =>
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (!event || event.isComposing || event.shiftKey || event.altKey) return false;
          event.preventDefault();
          event.stopPropagation();
          if (suggestionsOpenRef.current) {
            onSuggestionCommandRef.current("accept");
          } else {
            onSubmitRef.current(readEditorSnapshot(editor));
          }
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor],
  );

  useEffect(() => {
    const register = (
      command: typeof KEY_ARROW_DOWN_COMMAND,
      value: ComposerSuggestionCommand,
    ) =>
      editor.registerCommand(
        command,
        (event) => {
          if (!suggestionsOpenRef.current || !event || event.isComposing) return false;
          event.preventDefault();
          event.stopPropagation();
          onSuggestionCommandRef.current(value);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      );
    const removers = [
      register(KEY_ARROW_DOWN_COMMAND, "next"),
      register(KEY_ARROW_UP_COMMAND, "previous"),
      register(KEY_ESCAPE_COMMAND, "dismiss"),
      register(KEY_TAB_COMMAND, "accept"),
    ];
    return () => removers.forEach((remove) => remove());
  }, [editor]);

  useEffect(() => {
    const remove = (direction: "backward" | "forward", event: KeyboardEvent | null) => {
      if (!event || event.isComposing || !removeAdjacentMention(direction)) return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    };
    const backward = editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event) => remove("backward", event),
      COMMAND_PRIORITY_HIGH,
    );
    const forward = editor.registerCommand(
      KEY_DELETE_COMMAND,
      (event) => remove("forward", event),
      COMMAND_PRIORITY_HIGH,
    );
    return () => {
      backward();
      forward();
    };
  }, [editor]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      focus() {
        editor.getRootElement()?.focus({preventScroll: true});
      },
      replaceDocument(document) {
        editor.update(
          () => {
            replaceRootDocument(document);
            $getRoot().selectEnd();
          },
          {discrete: true},
        );
        latestDocumentKey.current = documentKey(document);
      },
      replaceMention(insertion) {
        const snapshot = readEditorSnapshot(editor);
        const result = replaceComposerDocumentRangeWithMention({
          document: snapshot.document,
          end: insertion.trigger.end,
          mention: insertion.mention,
          start: insertion.trigger.start,
        });
        editor.update(
          () => {
            replaceRootDocument(result.document);
            selectTextOffset(result.cursor);
          },
          {discrete: true},
        );
        latestDocumentKey.current = documentKey(result.document);
      },
      requestSubmit() {
        onSubmitRef.current(readEditorSnapshot(editor));
      },
    }),
    [editor],
  );

  return (
    <OnChangePlugin
      ignoreSelectionChange={false}
      onChange={(state) => {
        const snapshot = readSnapshot(state);
        latestDocumentKey.current = documentKey(snapshot.document);
        onSnapshotChangeRef.current(snapshot);
      }}
    />
  );
}

function readEditorSnapshot(editor: LexicalEditor): ComposerEditorSnapshot {
  return readSnapshot(editor.getEditorState());
}

function readSnapshot(editorState: EditorState): ComposerEditorSnapshot {
  let snapshot: ComposerEditorSnapshot = {
    document: createComposerDocument(),
    selection: null,
    text: "",
  };
  editorState.read(() => {
    const document = readRootDocument();
    snapshot = {
      document,
      selection: readSelection(),
      text: composerDocumentText(document),
    };
  });
  return snapshot;
}

function readRootDocument(): ComposerDocument {
  const nodes: ComposerNode[] = [];
  $getRoot().getChildren().forEach((child, index) => {
    if (index > 0) nodes.push({text: "\n", type: "text"});
    appendDocumentNodes(child, nodes);
  });
  return createComposerDocument(nodes);
}

function appendDocumentNodes(node: LexicalNode, output: ComposerNode[]): void {
  if ($isComposerMentionNode(node)) {
    output.push(node.toComposerNode());
  } else if ($isLineBreakNode(node)) {
    output.push({text: "\n", type: "text"});
  } else if ($isTextNode(node)) {
    output.push({text: node.getTextContent(), type: "text"});
  } else if ($isElementNode(node)) {
    node.getChildren().forEach((child) => appendDocumentNodes(child, output));
  }
}

function replaceRootDocument(document: ComposerDocument): void {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  for (const node of document.nodes) {
    if (node.type === "mention") {
      paragraph.append($createComposerMentionNode(node));
    } else {
      appendText(paragraph, node.text);
    }
  }
  root.append(paragraph);
}

function appendText(parent: ReturnType<typeof $createParagraphNode>, text: string): void {
  text.split("\n").forEach((line, index, lines) => {
    if (line) parent.append($createTextNode(line));
    if (index < lines.length - 1) parent.append($createLineBreakNode());
  });
}

function readSelection() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  return {
    end: pointToTextOffset(selection.focus.key, selection.focus.offset),
    start: pointToTextOffset(selection.anchor.key, selection.anchor.offset),
  };
}

function pointToTextOffset(key: string, pointOffset: number): number {
  const target = findNodeByKey($getRoot(), key);
  if (!target) return pointOffset;
  let offset = 0;
  let current: LexicalNode | null = target;
  while (current) {
    const parent: LexicalNode | null = current.getParent();
    if (!parent || !$isElementNode(parent)) break;
    for (let index = 0; index < current.getIndexWithinParent(); index += 1) {
      const sibling = parent.getChildAtIndex(index);
      if (sibling) offset += nodeTextLength(sibling);
    }
    current = parent;
  }
  if ($isTextNode(target) || $isLineBreakNode(target)) {
    return offset + Math.min(pointOffset, target.getTextContent().length);
  }
  return offset;
}

function nodeTextLength(node: LexicalNode): number {
  if ($isTextNode(node) || $isLineBreakNode(node)) return node.getTextContent().length;
  if (!$isElementNode(node)) return 0;
  return node.getChildren().reduce((total, child) => total + nodeTextLength(child), 0);
}

function selectTextOffset(index: number): void {
  const point = findPointAtTextOffset($getRoot(), {value: Math.max(0, index)});
  if (!point) {
    $getRoot().selectEnd();
    return;
  }
  const selection = $createRangeSelection();
  selection.anchor.set(point.key, point.offset, point.type);
  selection.focus.set(point.key, point.offset, point.type);
  $setSelection(selection);
}

function findPointAtTextOffset(
  node: LexicalNode,
  remaining: {value: number},
): {key: string; offset: number; type: "element" | "text"} | null {
  if ($isComposerMentionNode(node)) {
    const parent = node.getParent();
    if (!parent || !$isElementNode(parent)) return null;
    const index = node.getIndexWithinParent();
    const length = node.getTextContent().length;
    if (remaining.value === 0) return {key: parent.getKey(), offset: index, type: "element"};
    if (remaining.value <= length) {
      return {key: parent.getKey(), offset: index + 1, type: "element"};
    }
    remaining.value -= length;
    return null;
  }
  if ($isTextNode(node)) {
    const length = node.getTextContent().length;
    if (remaining.value <= length) {
      return {key: node.getKey(), offset: remaining.value, type: "text"};
    }
    remaining.value -= length;
    return null;
  }
  if ($isLineBreakNode(node)) {
    const parent = node.getParent();
    if (!parent || !$isElementNode(parent)) return null;
    if (remaining.value <= 1) {
      return {
        key: parent.getKey(),
        offset: node.getIndexWithinParent() + 1,
        type: "element",
      };
    }
    remaining.value -= 1;
    return null;
  }
  if ($isElementNode(node)) {
    for (const child of node.getChildren()) {
      const point = findPointAtTextOffset(child, remaining);
      if (point) return point;
    }
    return {key: node.getKey(), offset: node.getChildrenSize(), type: "element"};
  }
  return null;
}

function removeAdjacentMention(direction: "backward" | "forward"): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
  const target = findNodeByKey($getRoot(), selection.anchor.key);
  if (!target) return false;
  const candidate = adjacentMention(
    target,
    selection.anchor.offset,
    selection.anchor.type,
    direction,
  );
  if (!candidate) return false;
  const parent = candidate.getParent();
  if (!parent || !$isElementNode(parent)) return false;
  const index = candidate.getIndexWithinParent();
  candidate.remove();
  const next = $createRangeSelection();
  next.anchor.set(parent.getKey(), Math.min(index, parent.getChildrenSize()), "element");
  next.focus.set(parent.getKey(), Math.min(index, parent.getChildrenSize()), "element");
  $setSelection(next);
  return true;
}

function adjacentMention(
  target: LexicalNode,
  offset: number,
  pointType: "element" | "text",
  direction: "backward" | "forward",
): ComposerMentionNode | null {
  if ($isComposerMentionNode(target)) return target;
  if (pointType === "element" && $isElementNode(target)) {
    const child = target.getChildAtIndex(direction === "backward" ? offset - 1 : offset);
    return $isComposerMentionNode(child) ? child : null;
  }
  if ($isTextNode(target)) {
    if (direction === "backward" && offset === 0) {
      const sibling = target.getPreviousSibling();
      return $isComposerMentionNode(sibling) ? sibling : null;
    }
    if (direction === "forward" && offset === target.getTextContentSize()) {
      const sibling = target.getNextSibling();
      return $isComposerMentionNode(sibling) ? sibling : null;
    }
  }
  return null;
}

function findNodeByKey(node: LexicalNode, key: string): LexicalNode | null {
  if (node.getKey() === key) return node;
  if (!$isElementNode(node)) return null;
  for (const child of node.getChildren()) {
    const found = findNodeByKey(child, key);
    if (found) return found;
  }
  return null;
}

function documentKey(document: ComposerDocument): string {
  return JSON.stringify(document);
}

function editorStyle(appearance: ComposerEditorProps["appearance"]): CSSProperties {
  return {
    background: appearance.backgroundColor,
    boxSizing: "border-box",
    color: appearance.textColor,
    ["fontFamily"]: appearance.typeface,
    ["fontSize"]: appearance.textSize,
    ["lineHeight"]: `${appearance.textLeading}px`,
    maxHeight: appearance.maxHeight,
    minHeight: appearance.minHeight,
    outline: "none",
    overflowY: "auto",
    padding: `${appearance.paddingTop}px ${appearance.paddingHorizontal}px ${appearance.paddingBottom}px`,
    whiteSpace: "pre-wrap",
    width: "100%",
    wordBreak: "break-word",
  };
}

const EDITOR_CSS = `
  .vela-composer-editor-input { scrollbar-width: thin; }
  .vela-composer-editor-input p { margin: 0; }
  .vela-composer-mention {
    background: var(--vela-composer-chip-background);
    border-radius: 6px;
    color: var(--vela-composer-chip-text);
    display: inline-block;
    font-weight: 600;
    margin: 0 1px;
    padding: 1px 4px;
    white-space: nowrap;
  }
`;
