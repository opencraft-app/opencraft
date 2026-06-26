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
  $generateNodesFromRawText,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
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
} from "./model";
import type { ComposerEditorCursor, ComposerEditorHandle, ComposerEditorSnapshot } from "./types";

export interface LexicalComposerEditorProps {
  value: string;
  placeholder: string;
  className?: string;
  placeholderClassName?: string;
  ariaLabel?: string;
  disabled?: boolean;
  canSubmitText?: boolean;
  onChange: (value: string) => void;
  onSnapshotChange?: (snapshot: ComposerEditorSnapshot) => void;
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
    onChange,
    onSnapshotChange,
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
      editorState: () => {
        replaceRootText(initialValueRef.current);
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
        onSubmit={onSubmit}
        onSubmitText={onSubmitText}
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
  onSubmit,
  onSubmitText,
  value,
}: {
  disabled: boolean;
  canSubmitText: boolean;
  forwardedRef: ForwardedRef<ComposerEditorHandle>;
  onChange: (value: string) => void;
  onSnapshotChange?: (snapshot: ComposerEditorSnapshot) => void;
  onSubmit: () => void;
  onSubmitText?: (value: string) => void | Promise<void>;
  value: string;
}) {
  const [editor] = useLexicalComposerContext();
  const externalValueRef = useRef(value);
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
    });
  }, [value]);

  useEffect(() => {
    let currentValue = "";
    editor.getEditorState().read(() => {
      currentValue = $getRoot().getTextContent();
    });
    if (currentValue === value) return;
    editor.update(() => {
      replaceRootText(value);
    });
  }, [editor, value]);

  useEffect(
    () =>
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event: KeyboardEvent | null) => {
          if (!event || event.isComposing) return false;
          event.preventDefault();
          onSubmit();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor, onSubmit],
  );

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
          snapshot = createComposerEditorSnapshot({
            value: $getRoot().getTextContent(),
            cursor: readCurrentCursor($getRoot().getTextContent()),
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
          nextSnapshot = createComposerEditorSnapshot({
            value: nextValue,
            cursor: readCurrentCursor(nextValue),
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
            replaceRootText(replacementValue);
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

function replaceRootText(value: string) {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  paragraph.append(...$generateNodesFromRawText(value));
  root.append(paragraph);
  root.selectEnd();
}

function readCurrentCursor(value: string): ComposerEditorCursor | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  return {
    start: Math.min(
      value.length,
      pointToPlainTextOffset(selection.anchor.key, selection.anchor.offset),
    ),
    end: Math.min(
      value.length,
      pointToPlainTextOffset(selection.focus.key, selection.focus.offset),
    ),
  };
}

function pointToPlainTextOffset(key: string, offset: number): number {
  let plainTextOffset = 0;
  for (const node of collectPlainTextNodes()) {
    if (node.getKey() === key) return plainTextOffset + offset;
    plainTextOffset += node.getTextContent().length;
  }
  return offset;
}

function selectPlainTextOffset(index: number) {
  const root = $getRoot();
  const plainTextNodes = collectPlainTextNodes();
  if (plainTextNodes.length === 0) {
    root.selectEnd();
    return;
  }

  const targetOffset = Math.max(0, Math.trunc(index));
  let remainingOffset = targetOffset;
  for (const node of plainTextNodes) {
    const length = node.getTextContent().length;
    if (remainingOffset <= length) {
      if ($isTextNode(node)) {
        node.select(remainingOffset, remainingOffset);
      } else if ($isLineBreakNode(node) && remainingOffset === 0) {
        node.selectPrevious();
      } else {
        node.selectNext();
      }
      return;
    }
    remainingOffset -= length;
  }

  plainTextNodes[plainTextNodes.length - 1]?.selectEnd();
}

function collectPlainTextNodes(): LexicalNode[] {
  const nodes: LexicalNode[] = [];
  const visit = (node: LexicalNode) => {
    if ($isTextNode(node) || $isLineBreakNode(node)) {
      nodes.push(node);
      return;
    }
    if ($isElementNode(node)) {
      for (const child of node.getChildren()) visit(child);
    }
  };
  for (const child of $getRoot().getChildren()) visit(child);
  return nodes;
}
