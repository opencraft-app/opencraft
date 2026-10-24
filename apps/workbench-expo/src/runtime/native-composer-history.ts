import type { ComposerController, ComposerDocument } from "@opencraft/composer-core";

export interface NativeComposerHistorySelection {
  readonly start: number;
  readonly end: number;
}

interface Entry {
  readonly before: ComposerDocument;
  readonly after: ComposerDocument;
  readonly beforeSelection: NativeComposerHistorySelection;
  readonly afterSelection: NativeComposerHistorySelection;
}

interface DraftHistory {
  readonly undo: Entry[];
  readonly redo: Entry[];
}

const MAX_ENTRIES = 100;
const MAX_DRAFTS = 8;
const sessions = new WeakMap<ComposerController, NativeComposerHistory>();

/** Native View history restores documents; attachments keep their own Host lifecycle. */
export class NativeComposerHistory {
  private readonly drafts = new Map<string, DraftHistory>();

  record(
    draftId: string,
    before: ComposerDocument,
    after: ComposerDocument,
    beforeSelection: NativeComposerHistorySelection,
    afterSelection: NativeComposerHistorySelection,
  ): void {
    if (before === after) return;
    const history = this.drafts.get(draftId) ?? { undo: [], redo: [] };
    // A controller action outside the native editor may replace the Draft.
    // Never replay a history branch against an unrelated document.
    const expected = history.redo.at(-1)?.before ?? history.undo.at(-1)?.after;
    if (expected !== undefined && expected !== before) history.undo.length = 0;
    history.undo.push({ before, after, beforeSelection, afterSelection });
    if (history.undo.length > MAX_ENTRIES) history.undo.shift();
    history.redo.length = 0;
    this.drafts.delete(draftId);
    this.drafts.set(draftId, history);
    if (this.drafts.size > MAX_DRAFTS) this.drafts.delete(this.drafts.keys().next().value!);
  }

  canUndo(draftId: string, current: ComposerDocument): boolean {
    return this.drafts.get(draftId)?.undo.at(-1)?.after === current;
  }

  canRedo(draftId: string, current: ComposerDocument): boolean {
    return this.drafts.get(draftId)?.redo.at(-1)?.before === current;
  }

  undo(draftId: string, current: ComposerDocument): { document: ComposerDocument; selection: NativeComposerHistorySelection } | null {
    if (!this.canUndo(draftId, current)) return null;
    const history = this.drafts.get(draftId)!;
    const entry = history.undo.pop()!;
    history.redo.push(entry);
    return { document: entry.before, selection: entry.beforeSelection };
  }

  redo(draftId: string, current: ComposerDocument): { document: ComposerDocument; selection: NativeComposerHistorySelection } | null {
    if (!this.canRedo(draftId, current)) return null;
    const history = this.drafts.get(draftId)!;
    const entry = history.redo.pop()!;
    history.undo.push(entry);
    return { document: entry.after, selection: entry.afterSelection };
  }

  clear(): void { this.drafts.clear(); }
}

export function nativeComposerHistory(controller: ComposerController): NativeComposerHistory {
  let history = sessions.get(controller);
  if (history === undefined) {
    history = new NativeComposerHistory();
    sessions.set(controller, history);
    controller.onDispose(() => {
      history?.clear();
      sessions.delete(controller);
    });
  }
  return history;
}
