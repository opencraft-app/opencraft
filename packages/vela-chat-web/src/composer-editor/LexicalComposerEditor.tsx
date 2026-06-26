"use client";

import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import {
  $createParagraphNode,
  $createLineBreakNode,
  $createRangeSelection,
  $createTextNode,
  $generateNodesFromRawText,
  $getRoot,
  $getSelection,
  $setSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type EditorState,
  type LexicalNode,
} from "lexical";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type ForwardedRef,
} from "react";
import {
  createComposerEditorSnapshot,
  hasComposerLineBreak,
  normalizeComposerSingleLine,
  splitComposerInlineSegments,
} from "./model";
import {
  $createComposerSkillNode,
  $isComposerSkillNode,
  ComposerSkillNode,
} from "./ComposerSkillNode";
import type { ComposerEditorCursor, ComposerEditorHandle, ComposerEditorSnapshot } from "./types";

export interface LexicalComposerEditorProps {
  value: string;
  placeholder: string;
  className?: string;
  placeholderClassName?: string;
  ariaLabel?: string;
  disabled?: boolean;
  canSubmitText?: boolean;
  skillTokenNames?: readonly string[];
  onChange: (value: string) => void;
  onSnapshotChange?: (snapshot: ComposerEditorSnapshot) => void;
  onCommandKeyDown?: (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Escape" | "Tab",
    event: KeyboardEvent,
  ) => boolean;
  onSubmit: () => void;
  onSubmitText?: (value: string) => void | Promise<void>;
}

export const LexicalComposerEditor = forwardRef<
  ComposerEditorHandle,
  LexicalComposerEditorProps
>(function LexicalComposerEditor(
  {
    value,
    placeholder,
    className,
    placeholderClassName,
    ariaLabel = "Message",
    disabled = false,
    canSubmitText = false,
    skillTokenNames = [],
    onChange,
    onSnapshotChange,
    onCommandKeyDown,
    onSubmit,
    onSubmitText,
  },
  ref,
) {
  const initialValueRef = useRef(value);
  const initialEditableRef = useRef(!disabled);
  const initialConfig = useMemo(
    () => ({
      namespace: "VelaComposerEditor",
      editable: initialEditableRef.current,
      nodes: [ComposerSkillNode],
      editorState: () => {
        replaceRootText(initialValueRef.current, []);
      },
      onError(error: Error) {
        throw error;
      },
    }),
    [],
  );

  if (!canUseLexicalDom()) {
    return (
      <div
        aria-label={ariaLabel}
        aria-multiline="true"
        className={className}
        data-composer-editor="lexical"
        data-placeholder-visible={value.length === 0 ? "true" : "false"}
        role="textbox"
      >
        {value.length > 0 ? (
          value
        ) : (
          <span className={placeholderClassName}>{placeholder}</span>
        )}
      </div>
    );
  }

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <PlainTextPlugin
        contentEditable={
          <ContentEditable
            aria-label={ariaLabel}
            aria-multiline="true"
            className={className}
            data-composer-editor="lexical"
            spellCheck
          />
        }
        placeholder={<div className={placeholderClassName}>{placeholder}</div>}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
      <EditorBridgePlugin
        disabled={disabled}
        canSubmitText={canSubmitText}
        forwardedRef={ref}
        onChange={onChange}
        onSnapshotChange={onSnapshotChange}
        onCommandKeyDown={onCommandKeyDown}
        onSubmit={onSubmit}
        onSubmitText={onSubmitText}
        skillTokenNames={skillTokenNames}
        value={value}
      />
    </LexicalComposer>
  );
});

function canUseLexicalDom() {
  return (
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    typeof MutationObserver !== "undefined"
  );
}

function EditorBridgePlugin({
  disabled,
  canSubmitText,
  forwardedRef,
  onChange,
  onSnapshotChange,
  onCommandKeyDown,
  onSubmit,
  onSubmitText,
  skillTokenNames,
  value,
}: {
  disabled: boolean;
  canSubmitText: boolean;
  forwardedRef: ForwardedRef<ComposerEditorHandle>;
  onChange: (value: string) => void;
  onSnapshotChange?: (snapshot: ComposerEditorSnapshot) => void;
  onCommandKeyDown?: (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Escape" | "Tab",
    event: KeyboardEvent,
  ) => boolean;
  onSubmit: () => void;
  onSubmitText?: (value: string) => void | Promise<void>;
  skillTokenNames: readonly string[];
  value: string;
}) {
  const [editor] = useLexicalComposerContext();
  const externalValueRef = useRef(value);
  const skillTokenKey = useMemo(
    () => [...new Set(skillTokenNames)].sort().join("\n"),
    [skillTokenNames],
  );
  const renderedSkillTokenKeyRef = useRef("");
  const latestSnapshotRef = useRef<ComposerEditorSnapshot>(
    createComposerEditorSnapshot({ value }),
  );

  useEffect(() => {
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    externalValueRef.current = value;
    latestSnapshotRef.current = createComposerEditorSnapshot({
      value,
      cursor: latestSnapshotRef.current.cursor,
      expandedCursor: latestSnapshotRef.current.expandedCursor,
    });
  }, [value]);

  useEffect(() => {
    let currentValue = "";
    editor.getEditorState().read(() => {
      currentValue = $getRoot().getTextContent();
    });
    if (currentValue === value && renderedSkillTokenKeyRef.current === skillTokenKey) return;
    const cursorToRestore =
      currentValue === value ? latestSnapshotRef.current.expandedCursor?.start ?? value.length : value.length;
    editor.update(() => {
      replaceRootText(value, skillTokenNames);
      selectPlainTextOffset(cursorToRestore);
      renderedSkillTokenKeyRef.current = skillTokenKey;
    });
  }, [editor, skillTokenKey, skillTokenNames, value]);

  useEffect(
    () =>
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event: KeyboardEvent | null) => {
          if (!event || event.isComposing) return false;
          if (onCommandKeyDown?.("Enter", event)) {
            event.preventDefault();
            event.stopPropagation();
            return true;
          }
          event.preventDefault();
          onSubmit();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor, onCommandKeyDown, onSubmit],
  );

  useEffect(() => {
    const handleCommand = (
      key: "ArrowDown" | "ArrowUp" | "Escape" | "Tab",
      event: KeyboardEvent | null,
    ) => {
      if (!event || event.isComposing) return false;
      if (!onCommandKeyDown?.(key, event)) return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    };

    const unregisterArrowDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => handleCommand("ArrowDown", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterArrowUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => handleCommand("ArrowUp", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => handleCommand("Escape", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => handleCommand("Tab", event),
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unregisterArrowDown();
      unregisterArrowUp();
      unregisterEscape();
      unregisterTab();
    };
  }, [editor, onCommandKeyDown]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      focus() {
        editor.focus();
      },
      focusAt(index: number) {
        editor.focus(() => {
          selectPlainTextOffset(index);
        });
      },
      focusAtEnd() {
        editor.focus(() => {
          $getRoot().selectEnd();
        });
      },
      isFocused() {
        const rootElement = editor.getRootElement();
        return Boolean(
          rootElement &&
            typeof document !== "undefined" &&
            document.activeElement &&
            rootElement.contains(document.activeElement),
        );
      },
      readSnapshot() {
        let snapshot = latestSnapshotRef.current;
        editor.getEditorState().read(() => {
          const currentValue = $getRoot().getTextContent();
          const cursors = readCurrentCursors(currentValue);
          snapshot = createComposerEditorSnapshot({
            value: currentValue,
            cursor: cursors?.cursor ?? null,
            expandedCursor: cursors?.expandedCursor ?? null,
          });
        });
        latestSnapshotRef.current = snapshot;
        return snapshot;
      },
    }),
    [editor],
  );

  return (
    <OnChangePlugin
      ignoreSelectionChange={false}
      onChange={(editorState: EditorState) => {
        let nextValue = "";
        let nextSnapshot: ComposerEditorSnapshot | null = null;
        editorState.read(() => {
          nextValue = $getRoot().getTextContent();
          const cursors = readCurrentCursors(nextValue);
          nextSnapshot = createComposerEditorSnapshot({
            value: nextValue,
            cursor: cursors?.cursor ?? null,
            expandedCursor: cursors?.expandedCursor ?? null,
          });
        });
        if (!nextSnapshot) return;
        if (hasComposerLineBreak(nextValue)) {
          const shouldSubmitText = canSubmitText && Boolean(onSubmitText) && nextValue.trim();
          const replacementValue = shouldSubmitText
            ? ""
            : normalizeComposerSingleLine(nextValue);
          const replacementSnapshot = createComposerEditorSnapshot({
            value: replacementValue,
          });
          latestSnapshotRef.current = replacementSnapshot;
          onSnapshotChange?.(replacementSnapshot);
          externalValueRef.current = replacementValue;
          editor.update(() => {
            replaceRootText(replacementValue, skillTokenNames);
          });
          onChange(replacementValue);
          if (shouldSubmitText) void onSubmitText(nextValue);
          return;
        }
        latestSnapshotRef.current = nextSnapshot;
        onSnapshotChange?.(nextSnapshot);
        if (nextValue === externalValueRef.current) return;
        externalValueRef.current = nextValue;
        onChange(nextValue);
      }}
    />
  );
}

function replaceRootText(value: string, skillTokenNames: readonly string[]) {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  const segments = splitComposerInlineSegments(value, { skillNames: skillTokenNames });
  if (segments.length === 0) {
    paragraph.append(...$generateNodesFromRawText(value));
  } else {
    for (const segment of segments) {
      if (segment.type === "skill") {
        paragraph.append($createComposerSkillNode(segment.text));
      } else {
        appendTextWithLineBreaks(paragraph, segment.text);
      }
    }
  }
  root.append(paragraph);
  root.selectEnd();
}

function appendTextWithLineBreaks(parent: ReturnType<typeof $createParagraphNode>, text: string) {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.length > 0) parent.append($createTextNode(line));
    if (index < lines.length - 1) parent.append($createLineBreakNode());
  }
}

function readCurrentCursors(
  value: string,
): { cursor: ComposerEditorCursor; expandedCursor: ComposerEditorCursor } | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  return {
    cursor: {
      start: Math.min(
        value.length,
        pointToComposerOffset(selection.anchor.key, selection.anchor.offset),
      ),
      end: Math.min(value.length, pointToComposerOffset(selection.focus.key, selection.focus.offset)),
    },
    expandedCursor: {
      start: Math.min(
        value.length,
        pointToExpandedTextOffset(selection.anchor.key, selection.anchor.offset),
      ),
      end: Math.min(
        value.length,
        pointToExpandedTextOffset(selection.focus.key, selection.focus.offset),
      ),
    },
  };
}

function nodeComposerLength(node: LexicalNode): number {
  if ($isComposerSkillNode(node)) return 1;
  if ($isTextNode(node) || $isLineBreakNode(node)) return node.getTextContent().length;
  if ($isElementNode(node)) {
    return node.getChildren().reduce((total, child) => total + nodeComposerLength(child), 0);
  }
  return 0;
}

function nodeExpandedLength(node: LexicalNode): number {
  if ($isTextNode(node) || $isLineBreakNode(node)) return node.getTextContent().length;
  if ($isElementNode(node)) {
    return node.getChildren().reduce((total, child) => total + nodeExpandedLength(child), 0);
  }
  return 0;
}

function pointToComposerOffset(key: string, pointOffset: number): number {
  return pointToOffset(key, pointOffset, "collapsed");
}

function pointToExpandedTextOffset(key: string, pointOffset: number): number {
  return pointToOffset(key, pointOffset, "expanded");
}

function pointToOffset(key: string, pointOffset: number, mode: "collapsed" | "expanded"): number {
  const target = findNodeByKey($getRoot(), key);
  if (!target) return pointOffset;

  let offset = 0;
  let current: LexicalNode | null = target;
  while (current) {
    const parent = current.getParent();
    if (!parent || !$isElementNode(parent)) break;
    const siblings = parent.getChildren();
    const index = current.getIndexWithinParent();
    for (let siblingIndex = 0; siblingIndex < index; siblingIndex += 1) {
      const sibling = siblings[siblingIndex];
      if (!sibling) continue;
      offset += mode === "collapsed" ? nodeComposerLength(sibling) : nodeExpandedLength(sibling);
    }
    current = parent;
  }

  if ($isComposerSkillNode(target)) {
    return (
      offset +
      (pointOffset > 0 ? (mode === "collapsed" ? 1 : target.getTextContent().length) : 0)
    );
  }
  if ($isTextNode(target) || $isLineBreakNode(target)) {
    return offset + Math.min(pointOffset, target.getTextContent().length);
  }
  if ($isElementNode(target)) {
    const children = target.getChildren();
    const clampedOffset = Math.max(0, Math.min(pointOffset, children.length));
    for (let index = 0; index < clampedOffset; index += 1) {
      const child = children[index];
      if (!child) continue;
      offset += mode === "collapsed" ? nodeComposerLength(child) : nodeExpandedLength(child);
    }
  }
  return offset;
}

function selectPlainTextOffset(index: number) {
  const root = $getRoot();
  const point = findSelectionPointAtExpandedOffset(root, {
    value: Math.max(0, Math.trunc(index)),
  });
  if (!point) {
    root.selectEnd();
    return;
  }
  const selection = $createRangeSelection();
  selection.anchor.set(point.key, point.offset, point.type);
  selection.focus.set(point.key, point.offset, point.type);
  $setSelection(selection);
}

function findSelectionPointAtExpandedOffset(
  node: LexicalNode,
  remainingRef: { value: number },
): { key: string; offset: number; type: "text" | "element" } | null {
  if ($isComposerSkillNode(node)) {
    const parent = node.getParent();
    if (!parent || !$isElementNode(parent)) return null;
    const index = node.getIndexWithinParent();
    if (remainingRef.value === 0) return { key: parent.getKey(), offset: index, type: "element" };
    if (remainingRef.value <= node.getTextContent().length) {
      return { key: parent.getKey(), offset: index + 1, type: "element" };
    }
    remainingRef.value -= node.getTextContent().length;
    return null;
  }
  if ($isTextNode(node)) {
    const size = node.getTextContent().length;
    if (remainingRef.value <= size) {
      return { key: node.getKey(), offset: remainingRef.value, type: "text" };
    }
    remainingRef.value -= size;
    return null;
  }
  if ($isLineBreakNode(node)) {
    const parent = node.getParent();
    if (!parent || !$isElementNode(parent)) return null;
    const index = node.getIndexWithinParent();
    if (remainingRef.value <= 1) return { key: parent.getKey(), offset: index + 1, type: "element" };
    remainingRef.value -= 1;
    return null;
  }
  if ($isElementNode(node)) {
    for (const child of node.getChildren()) {
      const point = findSelectionPointAtExpandedOffset(child, remainingRef);
      if (point) return point;
    }
    return { key: node.getKey(), offset: node.getChildrenSize(), type: "element" };
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
