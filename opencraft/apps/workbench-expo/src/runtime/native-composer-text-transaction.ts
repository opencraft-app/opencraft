import { composerDocumentToPlainText, type ComposerDocument } from "@opencraft/composer-core";

import { backspaceNativeComposerListItemStart, backspaceNativeComposerQuoteStart, exitNativeComposerEmptyQuoteAtEnd, splitNativeComposerListItem, type NativeComposerRange } from "./native-composer-block-actions";
import { rebaseNativeComposerSelection, replaceNativeComposerText } from "./native-composer-document";

export interface NativeComposerTextTransaction {
  readonly document: ComposerDocument;
  readonly selection: NativeComposerRange | null;
  readonly rejected: boolean;
  /** The controlled native buffer must be replaced with the document projection. */
  readonly reconcileText: boolean;
}

/** Resolve a platform text event against the shared Draft before publishing it. */
export function applyNativeComposerTextTransaction(
  document: ComposerDocument,
  nativeText: string,
  selection: NativeComposerRange | null,
  makeId?: () => string,
): NativeComposerTextTransaction {
  const previousText = composerDocumentToPlainText(document);
  if (selection !== null && selection.start === selection.end) {
    const cursor = selection.start;
    if (cursor > 0 && nativeText === `${previousText.slice(0, cursor - 1)}${previousText.slice(cursor)}`) {
      const backspace = backspaceNativeComposerListItemStart(document, cursor)
        ?? backspaceNativeComposerQuoteStart(document, cursor);
      if (backspace !== null) return {
        document: backspace.document,
        selection: { start: backspace.cursor, end: backspace.cursor },
        rejected: false,
        reconcileText: composerDocumentToPlainText(backspace.document) !== nativeText,
      };
    }
    if (nativeText === `${previousText.slice(0, cursor)}\n${previousText.slice(cursor)}`) {
      const split = splitNativeComposerListItem(document, cursor, makeId);
      if (split !== null) return {
        document: split.document,
        selection: { start: split.cursor, end: split.cursor },
        rejected: false,
        reconcileText: true,
      };
      const exitQuote = exitNativeComposerEmptyQuoteAtEnd(document, cursor);
      if (exitQuote !== null) return {
        document: exitQuote.document,
        selection: { start: exitQuote.cursor, end: exitQuote.cursor },
        rejected: false,
        reconcileText: true,
      };
    }
  }
  const updated = replaceNativeComposerText(document, nativeText, selection);
  return {
    document: updated,
    selection: selection === null || updated === document
      ? selection : rebaseNativeComposerSelection(previousText, nativeText, selection),
    rejected: updated === document && nativeText !== previousText,
    reconcileText: updated === document && nativeText !== previousText,
  };
}
