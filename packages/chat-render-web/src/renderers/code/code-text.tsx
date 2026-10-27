import { Component, createElement, createRef } from "react";
import { captureTextSelection, restoreTextSelection, type TextSelectionSnapshot } from "../text-selection";

interface CodeTextProps {
  readonly code: string;
  readonly highlightedHtml: string | null;
}

/** Keep the reader's selection across text appends and syntax-only DOM updates. */
export class CodeText extends Component<CodeTextProps, object, TextSelectionSnapshot | null> {
  private readonly element = createRef<HTMLElement>();

  getSnapshotBeforeUpdate(previous: Readonly<CodeTextProps>): TextSelectionSnapshot | null {
    if (previous.code === this.props.code && previous.highlightedHtml === this.props.highlightedHtml) return null;
    // A replacement may change the meaning of the selected text. Only retain
    // offsets when the existing source is unchanged or extended at the end.
    if (!this.props.code.startsWith(previous.code)) return null;
    return captureTextSelection(this.element.current);
  }

  componentDidUpdate(_previous: Readonly<CodeTextProps>, _state: object, snapshot: TextSelectionSnapshot | null) {
    restoreTextSelection(snapshot);
  }

  render() {
    const { code, highlightedHtml } = this.props;
    return createElement("code", { ref: this.element,
      className: highlightedHtml === null ? undefined : "chat-code-highlight",
      dangerouslySetInnerHTML: highlightedHtml === null ? undefined : { __html: highlightedHtml } },
      highlightedHtml === null ? code : undefined);
  }
}
