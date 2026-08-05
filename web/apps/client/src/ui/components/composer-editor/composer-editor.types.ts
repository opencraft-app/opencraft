import type {
  ComposerDocument,
  ComposerEditorCursor,
  ComposerMentionNode,
  ComposerMentionTrigger,
} from "@vela/client-core";

export interface ComposerEditorAppearance {
  backgroundColor: string;
  chipBackgroundColor: string;
  chipTextColor: string;
  textLeading: number;
  textSize: number;
  typeface?: string;
  maxHeight: number;
  minHeight: number;
  paddingBottom: number;
  paddingHorizontal: number;
  paddingTop: number;
  placeholderColor: string;
  textColor: string;
}

export interface ComposerEditorSnapshot {
  document: ComposerDocument;
  selection: ComposerEditorCursor | null;
  text: string;
}

export type ComposerSuggestionCommand =
  | "accept"
  | "dismiss"
  | "next"
  | "previous";

export interface ComposerMentionInsertion {
  mention: ComposerMentionNode;
  trigger: ComposerMentionTrigger;
}

export interface ComposerEditorHandle {
  focus(): void;
  replaceDocument(document: ComposerDocument): void;
  replaceMention(insertion: ComposerMentionInsertion): void;
  requestSubmit(): void;
}

export interface ComposerEditorProps {
  appearance: ComposerEditorAppearance;
  disabled?: boolean;
  document: ComposerDocument;
  onSnapshotChange(snapshot: ComposerEditorSnapshot): void;
  onSubmit(snapshot: ComposerEditorSnapshot): void;
  onSuggestionCommand(command: ComposerSuggestionCommand): void;
  placeholder: string;
  suggestionsOpen: boolean;
}

export interface ComposerEditorDomHandle {
  [key: string]: (...args: ComposerBridgeValue[]) => void;
  focus(): void;
  replaceDocumentJson(value: ComposerBridgeValue): void;
  replaceMentionJson(value: ComposerBridgeValue): void;
  requestSubmit(): void;
}

export type ComposerBridgeValue =
  | boolean
  | number
  | string
  | null
  | ComposerBridgeValue[]
  | {[key: string]: ComposerBridgeValue | undefined};
