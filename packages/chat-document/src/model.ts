export type ChatDocumentNodeCompleteness = "open" | "complete" | "invalid";

export interface ChatDocumentSourceRange {
  readonly start: number;
  readonly end: number;
}

export interface ChatDocumentNodeBase<TKind extends string> {
  readonly kind: TKind;
  readonly stableKey: string;
  readonly completeness: ChatDocumentNodeCompleteness;
  readonly sourceRange: ChatDocumentSourceRange;
}

export interface ChatDocumentParentNode<TKind extends string>
  extends ChatDocumentNodeBase<TKind> {
  readonly children: readonly ChatDocumentNode[];
}

export interface ChatDocumentListNode extends ChatDocumentParentNode<"list"> {
  readonly ordered: boolean;
  readonly start: number | null;
}

export interface ChatDocumentListItemNode extends ChatDocumentParentNode<"list-item"> {
  readonly checked: boolean | null;
}

export interface ChatDocumentHeadingNode extends ChatDocumentParentNode<"heading"> {
  readonly depth: 1 | 2 | 3 | 4 | 5 | 6;
}

export interface ChatDocumentTextNode extends ChatDocumentNodeBase<"text"> {
  readonly text: string;
  /** Only segments introduced by the current committed stream revision enter. */
  readonly segments: readonly ChatTextSegment[];
}

export interface ChatDocumentReferenceNode extends ChatDocumentNodeBase<"reference"> {
  readonly text: string;
  readonly referenceKind: "variable" | "workspace-file";
  readonly segments: readonly ChatTextSegment[];
}

export interface ChatDocumentColorSwatchNode extends ChatDocumentNodeBase<"color-swatch"> {
  readonly text: string;
  readonly color: string;
  readonly segments: readonly ChatTextSegment[];
}

export interface ChatTextSegment {
  readonly key: string;
  readonly text: string;
  readonly entering: boolean;
}

export interface ChatDocumentInlineCodeNode extends ChatDocumentNodeBase<"inline-code"> {
  readonly code: string;
}

export interface ChatDocumentCodeFenceNode extends ChatDocumentNodeBase<"code-fence"> {
  readonly language: string | null;
  readonly code: string;
  readonly meta: string | null;
}

export interface ChatDocumentMathNode extends ChatDocumentNodeBase<"math"> {
  readonly source: string;
  readonly display: boolean;
}

export interface ChatDocumentLinkNode extends ChatDocumentParentNode<"link"> {
  readonly href: string;
  readonly title: string | null;
}

export interface ChatDocumentImageNode extends ChatDocumentNodeBase<"image"> {
  readonly src: string;
  readonly alt: string;
  readonly title: string | null;
}

export interface ChatDocumentTableNode extends ChatDocumentNodeBase<"table"> {
  /** Canonical Markdown copied by the table action surface. */
  readonly markdownSource: string;
  readonly header: readonly (readonly ChatDocumentNode[])[];
  readonly rows: readonly (readonly (readonly ChatDocumentNode[])[])[];
  readonly align: readonly ("left" | "center" | "right" | null)[];
}

export interface ChatDocumentDirectiveNode extends ChatDocumentNodeBase<"directive"> {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly raw: string;
}

export interface ChatDocumentUnknownNode extends ChatDocumentNodeBase<"unknown"> {
  readonly tokenType: string;
  readonly raw: string;
}

export type ChatDocumentNode =
  | ChatDocumentParentNode<"paragraph">
  | ChatDocumentHeadingNode
  | ChatDocumentParentNode<"blockquote">
  | ChatDocumentParentNode<"strong">
  | ChatDocumentParentNode<"emphasis">
  | ChatDocumentParentNode<"delete">
  | ChatDocumentParentNode<"root-fragment">
  | ChatDocumentListNode
  | ChatDocumentListItemNode
  | ChatDocumentTextNode
  | ChatDocumentReferenceNode
  | ChatDocumentColorSwatchNode
  | ChatDocumentInlineCodeNode
  | ChatDocumentCodeFenceNode
  | ChatDocumentMathNode
  | ChatDocumentLinkNode
  | ChatDocumentImageNode
  | ChatDocumentTableNode
  | ChatDocumentDirectiveNode
  | ChatDocumentNodeBase<"line-break">
  | ChatDocumentNodeBase<"horizontal-rule">
  | ChatDocumentUnknownNode;

export interface ChatDocumentSnapshot {
  readonly documentId: string;
  readonly revision: number;
  readonly source: string;
  readonly streaming: boolean;
  readonly nodes: readonly ChatDocumentNode[];
}

export interface ChatDocumentCompileCandidate {
  readonly snapshot: ChatDocumentSnapshot;
  /** Commits identity only after React has committed the corresponding tree. */
  commit(): void;
}
