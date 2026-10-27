import type { ContentBlock } from "./content";
import type { ComposerDocument, ComposerInline } from "./document";
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
