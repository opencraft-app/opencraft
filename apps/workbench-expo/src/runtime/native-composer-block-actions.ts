import {
  composerDocumentToPlainText,
  createClientId,
  type ComposerBlockNode,
  type ComposerDocument,
  type ComposerParagraphNode,
} from "@opencraft/composer-core";

export type NativeComposerBlockFormat = "paragraph" | "quote" | "bullets" | "numbers" | "code";
export type NativeComposerRange = { readonly start: number; readonly end: number };
export type NativeComposerBlockAction = {
  readonly document: ComposerDocument;
  readonly selection: NativeComposerRange;
};

type SimpleParagraph = { readonly paragraph: ComposerParagraphNode; readonly itemId: string | null };

const textLength = (block: ComposerBlockNode) => composerDocumentToPlainText({ version: 1, blocks: [block] }).length;

export function nativeComposerBlockFormatAt(document: ComposerDocument, cursor: number): NativeComposerBlockFormat | null {
  let offset = 0;
  for (const block of document.blocks) {
    if (cursor >= offset && cursor <= offset + textLength(block)) {
      if (block.type === "paragraph") return "paragraph";
      if (block.type === "quote") return "quote";
      if (block.type === "list") return block.ordered ? "numbers" : "bullets";
      if (block.type === "code-block") return "code";
      return null;
    }
    offset += textLength(block) + 1;
  }
  return null;
}

function simpleParagraphs(block: ComposerBlockNode): readonly SimpleParagraph[] | null {
  if (block.type === "paragraph") return [{ paragraph: block, itemId: null }];
  if (block.type === "code-block") return block.text.split("\n").map(text => ({
    paragraph: { type: "paragraph", children: text.length > 0 ? [{ type: "text", text }] : [] },
    itemId: null,
  }));
  if (block.type === "quote") return block.children.every(child => child.type === "paragraph")
    ? block.children.map(child => ({ paragraph: child as ComposerParagraphNode, itemId: null })) : null;
  if (block.type === "list") return block.items.every(item => item.children.length === 1 && item.children[0]?.type === "paragraph")
    ? block.items.map(item => ({ paragraph: item.children[0] as ComposerParagraphNode, itemId: item.id })) : null;
  return null;
}

function contentRanges(block: ComposerBlockNode, paragraphs: readonly SimpleParagraph[]): readonly NativeComposerRange[] {
  let offset = 0;
  return paragraphs.map(({ paragraph }, index) => {
    if (index > 0) offset += 1;
    if (block.type === "list") offset += block.ordered
      ? `${(block.start ?? 1) + index}. `.length : 2;
    const range = { start: offset, end: offset + textLength(paragraph) };
    offset = range.end;
    return range;
  });
}

function mapPosition(position: number, from: readonly NativeComposerRange[], to: readonly NativeComposerRange[]): number {
  const finalSource = from[from.length - 1];
  const finalTarget = to[to.length - 1];
  if (finalSource && finalTarget && position > finalSource.end) {
    return finalTarget.end + position - finalSource.end;
  }
  for (let index = 0; index < from.length; index += 1) {
    const source = from[index]!;
    const target = to[index]!;
    if (position <= source.end || index === from.length - 1) {
      return target.start + Math.max(0, Math.min(position - source.start, target.end - target.start));
    }
  }
  return position;
}

/** Format the selected top-level editable blocks without replacing text or inline marks. */
export function formatNativeComposerBlock(
  document: ComposerDocument,
  selection: NativeComposerRange,
  format: NativeComposerBlockFormat,
  makeId: () => string = createClientId,
): NativeComposerBlockAction | null {
  if (selection.start < 0 || selection.end < selection.start) return null;
  const spans: { block: ComposerBlockNode; start: number; end: number }[] = [];
  let offset = 0;
  for (const block of document.blocks) {
    const end = offset + textLength(block);
    spans.push({ block, start: offset, end });
    offset = end + 1;
  }
  if (selection.end > Math.max(0, offset - 1)) return null;
  const first = spans.findIndex(span => selection.start <= span.end);
  if (first < 0) return null;
  let last = first;
  if (selection.start !== selection.end) {
    for (let index = first + 1; index < spans.length && selection.end > spans[index]!.start; index += 1) {
      last = index;
    }
  }
  if (last < first) return null;
  const selected = spans.slice(first, last + 1);
  const simple: SimpleParagraph[] = [];
  const before: NativeComposerRange[] = [];
  const blockStart = selected[0]!.start;
  for (const span of selected) {
    const entries = simpleParagraphs(span.block);
    if (entries === null || entries.length === 0) return null;
    simple.push(...entries);
    before.push(...contentRanges(span.block, entries).map(range => ({
      start: span.start - blockStart + range.start,
      end: span.start - blockStart + range.end,
    })));
  }
  const paragraphs = simple.map(item => item.paragraph);
  const onlyBlock = selected.length === 1 ? selected[0]!.block : null;
  if (format === "code" && paragraphs.some(paragraph => paragraph.children.some(inline =>
    inline.type !== "text" || (inline.marks?.length ?? 0) > 0))) return null;
  const replacement: readonly ComposerBlockNode[] = format === "paragraph"
    ? paragraphs
    : format === "quote"
      ? [{ type: "quote", children: paragraphs }]
      : format === "code"
        ? [onlyBlock?.type === "code-block" ? onlyBlock : {
          type: "code-block", text: paragraphs.map(paragraph => paragraph.children.map(inline =>
            inline.type === "text" ? inline.text : "").join("")).join("\n"),
        }]
        : [{
          type: "list",
          ordered: format === "numbers",
          ...(onlyBlock?.type === "list" && onlyBlock.ordered && format === "numbers" ? { start: onlyBlock.start } : {}),
          items: simple.map(item => ({ id: item.itemId ?? makeId(), children: [item.paragraph] })),
        }];
  const updated: ComposerDocument = {
    version: 1,
    blocks: [...document.blocks.slice(0, first), ...replacement, ...document.blocks.slice(last + 1)],
  };
  const after = contentRanges(replacement.length === 1 ? replacement[0]! : { type: "quote", children: paragraphs }, simple);
  return {
    document: updated,
    selection: {
      start: blockStart + mapPosition(selection.start - blockStart, before, after),
      end: blockStart + mapPosition(selection.end - blockStart, before, after),
    },
  };
}

/** Native Enter becomes a new list item; Enter on an empty item exits the list. */
export function splitNativeComposerListItem(
  document: ComposerDocument,
  cursor: number,
  makeId: () => string = createClientId,
): { readonly document: ComposerDocument; readonly cursor: number } | null {
  if (cursor < 0) return null;
  let blockStart = 0;
  for (const [blockIndex, block] of document.blocks.entries()) {
    const blockEnd = blockStart + textLength(block);
    if (cursor < blockStart || cursor > blockEnd) {
      blockStart = blockEnd + 1;
      continue;
    }
    if (block.type !== "list") return null;
    const simple = simpleParagraphs(block);
    if (simple === null) return null;
    const ranges = contentRanges(block, simple);
    const itemIndex = ranges.findIndex(range => cursor >= blockStart + range.start && cursor <= blockStart + range.end);
    if (itemIndex < 0) return null;
    const range = ranges[itemIndex]!;
    const paragraph = simple[itemIndex]!.paragraph;
    const paragraphText = composerDocumentToPlainText({ version: 1, blocks: [paragraph] });
    const local = cursor - blockStart - range.start;
    if (paragraphText.length === 0) {
      const beforeItems = block.items.slice(0, itemIndex);
      const afterItems = block.items.slice(itemIndex + 1);
      const replacement: ComposerBlockNode[] = [
        ...(beforeItems.length > 0 ? [{ ...block, items: beforeItems }] : []),
        paragraph,
        ...(afterItems.length > 0 ? [{
          ...block,
          ...(block.ordered ? { start: (block.start ?? 1) + itemIndex + 1 } : {}),
          items: afterItems,
        }] : []),
      ];
      const updated: ComposerDocument = { version: 1, blocks: [
        ...document.blocks.slice(0, blockIndex), ...replacement, ...document.blocks.slice(blockIndex + 1),
      ] };
      const beforeParagraph = [
        ...document.blocks.slice(0, blockIndex),
        ...(beforeItems.length > 0 ? [{ ...block, items: beforeItems }] : []),
        paragraph,
      ];
      return {
        document: updated,
        cursor: composerDocumentToPlainText({ version: 1, blocks: beforeParagraph }).length,
      };
    }
    // Split text runs, but keep atomic inlines intact at their boundaries.
    const split = splitParagraphAt(paragraph, local);
    if (split === null) return null;
    const items = [
      ...block.items.slice(0, itemIndex),
      { ...block.items[itemIndex]!, children: [split[0]] },
      { id: makeId(), children: [split[1]] },
      ...block.items.slice(itemIndex + 1),
    ];
    const updated: ComposerDocument = { version: 1, blocks: document.blocks.map((candidate, index) =>
      index === blockIndex ? { ...block, items } : candidate) };
    const nextMarker = block.ordered ? `${(block.start ?? 1) + itemIndex + 1}. ` : "- ";
    return { document: updated, cursor: cursor + 1 + nextMarker.length };
  }
  return null;
}

/** A second Enter on the trailing empty quote paragraph returns to normal text. */
export function exitNativeComposerEmptyQuoteAtEnd(
  document: ComposerDocument,
  cursor: number,
): { readonly document: ComposerDocument; readonly cursor: number } | null {
  let blockStart = 0;
  for (const [blockIndex, block] of document.blocks.entries()) {
    if (block.type === "quote" && block.children.length > 0
      && cursor === blockStart + textLength(block)) {
      const last = block.children[block.children.length - 1]!;
      if (last.type !== "paragraph" || textLength(last) !== 0) return null;
      const quoted = block.children.slice(0, -1);
      const replacement: ComposerBlockNode[] = [
        ...(quoted.length > 0 ? [{ ...block, children: quoted }] : []),
        last,
      ];
      const updated: ComposerDocument = { version: 1, blocks: [
        ...document.blocks.slice(0, blockIndex),
        ...replacement,
        ...document.blocks.slice(blockIndex + 1),
      ] };
      return { document: updated, cursor: blockStart + textLength(block) };
    }
    blockStart += textLength(block) + 1;
  }
  return null;
}

/** Backspace at a list-item start exits the list or joins its previous item. */
export function backspaceNativeComposerListItemStart(
  document: ComposerDocument,
  cursor: number,
): { readonly document: ComposerDocument; readonly cursor: number } | null {
  let blockStart = 0;
  for (const [blockIndex, block] of document.blocks.entries()) {
    if (block.type === "list" && block.items.length > 0) {
      let itemStart = blockStart;
      for (const [itemIndex, item] of block.items.entries()) {
        const markerLength = block.ordered ? `${(block.start ?? 1) + itemIndex}. `.length : 2;
        if (cursor === itemStart + markerLength) {
          const paragraph = item.children.length === 1 && item.children[0]?.type === "paragraph"
            ? item.children[0] : null;
          if (paragraph === null) return null;
          if (itemIndex === 0) {
            const remaining = block.items.slice(1);
            return {
              document: { version: 1, blocks: [
                ...document.blocks.slice(0, blockIndex),
                paragraph,
                ...(remaining.length > 0 ? [{
                  ...block,
                  ...(block.ordered ? { start: (block.start ?? 1) + 1 } : {}),
                  items: remaining,
                }] : []),
                ...document.blocks.slice(blockIndex + 1),
              ] },
              cursor: blockStart,
            };
          }
          const previous = block.items[itemIndex - 1]!;
          if (previous.children.length !== 1 || previous.children[0]?.type !== "paragraph") return null;
          const merged = { ...previous, children: [{
            ...previous.children[0], children: [...previous.children[0].children, ...paragraph.children],
          }] };
          return {
            document: { version: 1, blocks: document.blocks.map((candidate, index) =>
              index === blockIndex ? { ...block, items: [
                ...block.items.slice(0, itemIndex - 1), merged, ...block.items.slice(itemIndex + 1),
              ] } : candidate) },
            cursor: itemStart - 1,
          };
        }
        itemStart += markerLength + composerDocumentToPlainText({ version: 1, blocks: item.children }).length + 1;
      }
    }
    blockStart += textLength(block) + 1;
  }
  return null;
}

/** Join the first quoted paragraph to the preceding paragraph on Backspace. */
export function backspaceNativeComposerQuoteStart(
  document: ComposerDocument,
  cursor: number,
): { readonly document: ComposerDocument; readonly cursor: number } | null {
  let blockStart = 0;
  for (const [blockIndex, block] of document.blocks.entries()) {
    if (cursor === blockStart && blockIndex > 0 && block.type === "quote") {
      const previous = document.blocks[blockIndex - 1];
      const first = block.children[0];
      if (previous?.type !== "paragraph" || first?.type !== "paragraph") return null;
      const remaining = block.children.slice(1);
      return {
        document: { version: 1, blocks: [
          ...document.blocks.slice(0, blockIndex - 1),
          { ...previous, children: [...previous.children, ...first.children] },
          ...(remaining.length > 0 ? [{ ...block, children: remaining }] : []),
          ...document.blocks.slice(blockIndex + 1),
        ] },
        cursor: blockStart - 1,
      };
    }
    blockStart += textLength(block) + 1;
  }
  return null;
}

function splitParagraphAt(paragraph: ComposerParagraphNode, offset: number): readonly [ComposerParagraphNode, ComposerParagraphNode] | null {
  const left: ComposerParagraphNode["children"][number][] = [];
  const right: ComposerParagraphNode["children"][number][] = [];
  let position = 0;
  for (const inline of paragraph.children) {
    const length = composerDocumentToPlainText({ version: 1, blocks: [{ type: "paragraph", children: [inline] }] }).length;
    if (inline.type === "text") {
      const split = Math.max(0, Math.min(offset - position, length));
      if (split > 0) left.push({ ...inline, text: inline.text.slice(0, split) });
      if (split < length) right.push({ ...inline, text: inline.text.slice(split) });
    } else {
      if (offset > position && offset < position + length) return null;
      (offset <= position ? right : left).push(inline);
    }
    position += length;
  }
  return [{ type: "paragraph", children: left }, { type: "paragraph", children: right }];
}
