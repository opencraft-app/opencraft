import type { ContentBlock } from "./content";
import type { ComposerBlockNode, ComposerDocument, ComposerInline, ComposerParagraphNode } from "./document";
import type { ComposerAttachment, ComposerContextReference } from "./model";

export interface LegacyComposerProjection {
  readonly document: ComposerDocument;
  readonly attachments: readonly ComposerAttachment[];
  readonly context: readonly ComposerContextReference[];
}

/** Transitional adapter only. New persistence and AppServer submission use ComposerDocument directly. */
export function legacyContentBlocksToComposer(blocks: readonly ContentBlock[]): LegacyComposerProjection {
  const inlines: ComposerInline[] = [];
  const attachments: ComposerAttachment[] = [];
  const context: ComposerContextReference[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text": inlines.push({ type: "text", text: block.text }); break;
      case "mention": inlines.push({
        type: "mention",
        id: block.id,
        label: block.label,
        mentionKind: "generic",
      }); break;
      case "command": inlines.push({ type: "command", name: block.name, argument: block.argument }); break;
      case "attachment": attachments.push({
        id: block.id,
        name: block.name,
        mimeType: block.mimeType,
        size: block.size,
        uri: block.uri ?? null,
        lifecycle: "ready",
        error: null,
      }); break;
      case "resource": {
        inlines.push({ type: "resource", id: block.id, title: block.title, uri: block.uri });
        context.push({ id: block.id, kind: "resource", title: block.title, uri: block.uri, visible: true });
        break;
      }
    }
  }
  return {
    document: { version: 1, blocks: [{ type: "paragraph", children: inlines }] },
    attachments,
    context,
  };
}

function paragraphToLegacy(paragraph: ComposerParagraphNode): ContentBlock[] {
  return paragraph.children.flatMap((inline): ContentBlock[] => {
    switch (inline.type) {
      case "text": return [{ type: "text", text: inline.text }];
      case "mention": return [{ type: "mention", id: inline.id, label: inline.label }];
      case "command": return [{ type: "command", name: inline.name, argument: inline.argument }];
      case "resource": return [{ type: "resource", id: inline.id, title: inline.title, uri: inline.uri }];
      case "link": return [{ type: "text", text: inline.children.map((child) => child.text).join("") }];
      case "hard-break": return [{ type: "text", text: "\n" }];
    }
  });
}

export function composerDocumentToLegacyContentBlocks(value: ComposerDocument): readonly ContentBlock[] {
  const blockToLegacy = (block: ComposerBlockNode): ContentBlock[] => {
    switch (block.type) {
      case "paragraph": return paragraphToLegacy(block);
      case "code-block": return [{ type: "text", text: block.text }];
      case "divider": return [{ type: "text", text: "---" }];
      case "quote": return block.children.flatMap((child, index) => [
        ...(index === 0 ? [] : [{ type: "text", text: "\n" } as ContentBlock]),
        ...blockToLegacy(child),
      ]);
      case "list": return block.items.flatMap((item, itemIndex) => [
        { type: "text", text: `${block.ordered ? `${(block.start ?? 1) + itemIndex}.` : "-"} ` } as ContentBlock,
        ...item.children.flatMap((child) => blockToLegacy(child)),
        { type: "text", text: "\n" } as ContentBlock,
      ]);
    }
  };
  return value.blocks.flatMap((block, index): ContentBlock[] => {
    const separator: ContentBlock[] = index === 0 ? [] : [{ type: "text", text: "\n" }];
    return [...separator, ...blockToLegacy(block)];
  });
}
