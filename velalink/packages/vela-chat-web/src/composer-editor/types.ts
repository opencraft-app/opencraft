export interface ComposerEditorCursor {
  start: number;
  end: number;
}

export interface ComposerEditorSnapshot {
  value: string;
  cursor: ComposerEditorCursor | null;
  expandedCursor: ComposerEditorCursor | null;
  tokenIds: string[];
}

export interface ComposerEditorHandle {
  focus: () => void;
  focusAt: (index: number) => void;
  focusAtEnd: () => void;
  isFocused: () => boolean;
  readSnapshot: () => ComposerEditorSnapshot;
}
