export interface ComposerTextInline {
  readonly type: "text";
  readonly text: string;
  readonly marks?: readonly ("strong" | "emphasis" | "code")[];
}

export interface ComposerMentionInline {
  readonly type: "mention";
  readonly id: string;
  readonly label: string;
  readonly mentionKind: "file" | "agent" | "thread" | "person" | "generic";
  readonly uri?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ComposerCommandInline {
  readonly type: "command";
  readonly name: string;
  readonly argument?: string;
  readonly uri?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ComposerResourceInline {
  readonly type: "resource";
  readonly id: string;
  readonly title: string;
  readonly uri: string;
  readonly resourceKind?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ComposerLinkInline {
  readonly type: "link";
  readonly href: string;
  readonly children: readonly ComposerTextInline[];
}

export interface ComposerHardBreakInline {
  readonly type: "hard-break";
}

export type ComposerInline =
  | ComposerTextInline
  | ComposerMentionInline
  | ComposerCommandInline
  | ComposerResourceInline
  | ComposerLinkInline
  | ComposerHardBreakInline;

export interface ComposerParagraphNode {
  readonly type: "paragraph";
  readonly children: readonly ComposerInline[];
}

export interface ComposerCodeBlockNode {
  readonly type: "code-block";
  readonly language?: string;
  readonly text: string;
}

export interface ComposerQuoteNode {
  readonly type: "quote";
  readonly children: readonly ComposerBlockNode[];
}

export interface ComposerListItemNode {
  readonly id: string;
  readonly children: readonly ComposerBlockNode[];
}

export interface ComposerListNode {
  readonly type: "list";
  readonly ordered: boolean;
  readonly start?: number;
  readonly items: readonly ComposerListItemNode[];
}

export interface ComposerDividerNode {
  readonly type: "divider";
}

export type ComposerBlockNode =
  | ComposerParagraphNode
  | ComposerCodeBlockNode
  | ComposerQuoteNode
  | ComposerListNode
  | ComposerDividerNode;

export interface ComposerDocument {
  readonly version: 1;
  readonly blocks: readonly ComposerBlockNode[];
}

export function createEmptyComposerDocument(): ComposerDocument {
  return { version: 1, blocks: [{ type: "paragraph", children: [] }] };
}

function inlineText(inline: ComposerInline): string {
  switch (inline.type) {
    case "text": return inline.text;
    case "mention": return `@${inline.label}`;
    case "command": return `/${inline.name}${inline.argument === undefined ? "" : ` ${inline.argument}`}`;
    case "resource": return inline.title;
    case "link": return inline.children.map((child) => child.text).join("");
    case "hard-break": return "\n";
  }
}

function paragraphText(paragraph: ComposerParagraphNode): string {
  return paragraph.children.map(inlineText).join("");
}

function blockText(block: ComposerBlockNode): string {
  switch (block.type) {
    case "paragraph": return paragraphText(block);
    case "code-block": return block.text;
    case "divider": return "---";
    case "quote": return block.children.map(blockText).join("\n");
    case "list": return block.items.map((item, index) => {
      const marker = block.ordered ? `${(block.start ?? 1) + index}.` : "-";
      return `${marker} ${item.children.map(blockText).join("\n")}`;
    }).join("\n");
  }
}

export function composerDocumentToPlainText(value: ComposerDocument): string {
  return value.blocks.map(blockText).join("\n");
}

function blockIsEmpty(block: ComposerBlockNode): boolean {
  switch (block.type) {
    case "paragraph": return block.children.length === 0 || block.children.every((inline) => inline.type === "text" && inline.text.length === 0);
    case "code-block": return block.text.length === 0;
    case "divider": return false;
    case "quote": return block.children.every(blockIsEmpty);
    case "list": return block.items.every((item) => item.children.every(blockIsEmpty));
  }
}

export function isComposerDocumentEmpty(value: ComposerDocument): boolean {
  return value.blocks.every(blockIsEmpty);
}
