import {
  composerDocumentToPlainText,
  type ComposerBlockNode,
  type ComposerDocument,
  type ComposerInline,
  type ComposerLinkInline,
  type ComposerTextInline,
} from "@opencraft/composer-core";

type Mark = NonNullable<ComposerTextInline["marks"]>[number];
type AtomicSource = { readonly inline: ComposerInline; readonly length: number };
type Character = {
  readonly text: string;
  readonly marks: readonly Mark[];
  readonly link?: ComposerLinkInline;
  readonly atomic?: AtomicSource;
  readonly atomicOffset?: number;
};

type EditableLeaf = {
  readonly block: Extract<ComposerBlockNode, { type: "paragraph" | "code-block" }>;
  readonly start: number;
  replace(blocks: readonly ComposerBlockNode[]): ComposerDocument;
};

type EditableParagraphScope = {
  readonly blocks: readonly ComposerBlockNode[];
  readonly start: number;
  replace(blocks: readonly ComposerBlockNode[]): ComposerDocument;
};

function blockLength(block: ComposerBlockNode): number {
  return composerDocumentToPlainText({ version: 1, blocks: [block] }).length;
}

/** Locate a nested editable leaf without crossing generated list markers or block separators. */
function findNestedEditableLeaf(document: ComposerDocument, start: number, end: number): EditableLeaf | null {
  const visit = (
    block: ComposerBlockNode,
    offset: number,
    nested: boolean,
    replace: EditableLeaf["replace"],
  ): EditableLeaf | null => {
    const length = blockLength(block);
    if (start < offset || end > offset + length) return null;
    if (block.type === "paragraph" || block.type === "code-block") {
      return nested ? { block, start: offset, replace } : null;
    }
    if (block.type === "quote") {
      let childOffset = offset;
      for (const [index, child] of block.children.entries()) {
        const found = visit(child, childOffset, true, blocks => replace([{
          ...block,
          children: [...block.children.slice(0, index), ...blocks, ...block.children.slice(index + 1)],
        }]));
        if (found) return found;
        childOffset += blockLength(child) + 1;
      }
    }
    if (block.type === "list") {
      let itemOffset = offset;
      for (const [itemIndex, item] of block.items.entries()) {
        const marker = block.ordered ? `${(block.start ?? 1) + itemIndex}. ` : "- ";
        let childOffset = itemOffset + marker.length;
        for (const [childIndex, child] of item.children.entries()) {
          const found = visit(child, childOffset, true, blocks => replace([{
            ...block,
            items: block.items.map((candidate, index) => index === itemIndex ? {
              ...item,
              children: [...item.children.slice(0, childIndex), ...blocks, ...item.children.slice(childIndex + 1)],
            } : candidate),
          }]));
          if (found) return found;
          childOffset += blockLength(child) + 1;
        }
        itemOffset += marker.length + item.children.reduce((length, child) => length + blockLength(child), 0)
          + Math.max(0, item.children.length - 1) + 1;
      }
    }
    return null;
  };

  let offset = 0;
  for (const [index, block] of document.blocks.entries()) {
    const found = visit(block, offset, false, blocks => ({
      version: 1,
      blocks: [...document.blocks.slice(0, index), ...blocks, ...document.blocks.slice(index + 1)],
    }));
    if (found) return found;
    offset += blockLength(block) + 1;
  }
  return null;
}

/** Edit paragraph separators inside one quote or list item without flattening its parent. */
function findNestedParagraphScope(document: ComposerDocument, start: number, end: number): EditableParagraphScope | null {
  const visit = (
    block: ComposerBlockNode,
    offset: number,
    replace: EditableParagraphScope["replace"],
  ): EditableParagraphScope | null => {
    if (block.type === "quote") {
      let childOffset = offset;
      for (const [index, child] of block.children.entries()) {
        const found = visit(child, childOffset, blocks => replace([{
          ...block,
          children: [...block.children.slice(0, index), ...blocks, ...block.children.slice(index + 1)],
        }]));
        if (found) return found;
        childOffset += blockLength(child) + 1;
      }
      if (start >= offset && end <= offset + blockLength(block)
        && block.children.every(child => child.type === "paragraph")) {
        return { blocks: block.children, start: offset, replace: blocks => replace([{ ...block, children: blocks }]) };
      }
    }
    if (block.type === "list") {
      let itemOffset = offset;
      for (const [itemIndex, item] of block.items.entries()) {
        const marker = block.ordered ? `${(block.start ?? 1) + itemIndex}. ` : "- ";
        const contentStart = itemOffset + marker.length;
        let childOffset = contentStart;
        for (const [childIndex, child] of item.children.entries()) {
          const found = visit(child, childOffset, blocks => replace([{
            ...block,
            items: block.items.map((candidate, index) => index === itemIndex ? {
              ...item,
              children: [...item.children.slice(0, childIndex), ...blocks, ...item.children.slice(childIndex + 1)],
            } : candidate),
          }]));
          if (found) return found;
          childOffset += blockLength(child) + 1;
        }
        const contentEnd = childOffset - (item.children.length > 0 ? 1 : 0);
        if (start >= contentStart && end <= contentEnd
          && item.children.every(child => child.type === "paragraph")) {
          return { blocks: item.children, start: contentStart, replace: blocks => replace([{
            ...block,
            items: block.items.map((candidate, index) => index === itemIndex ? { ...item, children: blocks } : candidate),
          }]) };
        }
        itemOffset = contentEnd + 1;
      }
    }
    return null;
  };

  let offset = 0;
  for (const [index, block] of document.blocks.entries()) {
    const found = visit(block, offset, blocks => ({
      version: 1,
      blocks: [...document.blocks.slice(0, index), ...blocks, ...document.blocks.slice(index + 1)],
    }));
    if (found) return found;
    offset += blockLength(block) + 1;
  }
  return null;
}

/** Rebase the last native selection while waiting for its next selection event. */
export function rebaseNativeComposerSelection(
  previousText: string,
  nextText: string,
  selection: { readonly start: number; readonly end: number },
): { readonly start: number; readonly end: number } {
  if (previousText === nextText) return selection;
  const bounds = resolveNativeEditBounds(previousText, nextText, selection);
  if (selection.start >= bounds.oldEnd) {
    const delta = nextText.length - previousText.length;
    return { start: selection.start + delta, end: selection.end + delta };
  }
  if (selection.end < bounds.start) return selection;
  return { start: bounds.nextEnd, end: bounds.nextEnd };
}

function textCharacters(document: ComposerDocument): Character[] | null {
  if (document.blocks.length !== 1 || document.blocks[0]?.type !== "paragraph") return null;
  const characters: Character[] = [];
  for (const inline of document.blocks[0].children) {
    if (inline.type === "text") {
      for (const text of inline.text.split("")) characters.push({ text, marks: inline.marks ?? [] });
      continue;
    }
    if (inline.type === "link") {
      for (const child of inline.children) {
        for (const text of child.text.split("")) characters.push({ text, marks: child.marks ?? [], link: inline });
      }
      continue;
    }
    const text = composerDocumentToPlainText({ version: 1, blocks: [{ type: "paragraph", children: [inline] }] });
    const atomic = { inline, length: text.length };
    for (const [atomicOffset, character] of text.split("").entries()) {
      characters.push({ text: character, marks: [], atomic, atomicOffset });
    }
  }
  return characters;
}

function sameMarks(left: readonly Mark[], right: readonly Mark[]): boolean {
  return left.length === right.length && left.every((mark, index) => mark === right[index]);
}

function documentFromCharacters(characters: readonly Character[]): ComposerDocument {
  const children: ComposerInline[] = [];
  let previousLink: ComposerLinkInline | undefined;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    if (character.atomic && character.atomicOffset === 0) {
      const span = characters.slice(index, index + character.atomic.length);
      const complete = span.length === character.atomic.length && span.every((candidate, position) =>
        candidate.atomic === character.atomic && candidate.atomicOffset === position);
      if (complete) {
        children.push(character.atomic.inline);
        previousLink = undefined;
        index += character.atomic.length - 1;
        continue;
      }
    }
    if (character.link) {
      const previous = children[children.length - 1];
      if (previous?.type === "link" && previousLink === character.link) {
        const linkChildren = [...previous.children];
        const last = linkChildren[linkChildren.length - 1];
        if (last && sameMarks(last.marks ?? [], character.marks)) {
          linkChildren[linkChildren.length - 1] = { ...last, text: last.text + character.text };
        } else {
          linkChildren.push(character.marks.length > 0
            ? { type: "text", text: character.text, marks: character.marks }
            : { type: "text", text: character.text });
        }
        children[children.length - 1] = { ...previous, children: linkChildren };
      } else {
        children.push({ type: "link", href: character.link.href, children: [character.marks.length > 0
          ? { type: "text", text: character.text, marks: character.marks }
          : { type: "text", text: character.text }] });
      }
      previousLink = character.link;
      continue;
    }
    previousLink = undefined;
    const previous = children[children.length - 1];
    if (previous?.type === "text" && sameMarks(previous.marks ?? [], character.marks)) {
      children[children.length - 1] = { ...previous, text: previous.text + character.text };
    } else {
      children.push(character.marks.length > 0
        ? { type: "text", text: character.text, marks: character.marks }
        : { type: "text", text: character.text });
    }
  }
  return { version: 1, blocks: [{ type: "paragraph", children }] };
}

function documentFromEditedLines(characters: readonly (Character | null)[]): ComposerDocument {
  const blocks: ComposerDocument["blocks"][number][] = [];
  let line: Character[] = [];
  for (const character of characters) {
    if (character === null) {
      blocks.push(documentFromCharacters(line).blocks[0]!);
      line = [];
    } else {
      line.push(character);
    }
  }
  blocks.push(documentFromCharacters(line).blocks[0]!);
  return { version: 1, blocks };
}

function resolveNativeEditBounds(
  oldText: string,
  nextText: string,
  selection: { readonly start: number; readonly end: number } | null,
): { readonly start: number; readonly oldEnd: number; readonly nextEnd: number } {
  let prefix = 0;
  while (prefix < oldText.length && prefix < nextText.length && oldText[prefix] === nextText[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldText.length - prefix && suffix < nextText.length - prefix
    && oldText[oldText.length - suffix - 1] === nextText[nextText.length - suffix - 1]) suffix += 1;
  const removed = oldText.length - prefix - suffix;
  const inserted = nextText.length - prefix - suffix;
  if (selection === null) return { start: prefix, oldEnd: prefix + removed, nextEnd: prefix + inserted };

  // Repeated characters can make a shortest edit valid at several offsets.
  // Prefer the previous native selection, preserving marks on the untouched run.
  const target = selection.start < selection.end || removed === 0
    ? selection.start : selection.start - removed;
  // A candidate before the common prefix is valid exactly when the remaining
  // suffix matches. Compute that suffix once instead of comparing whole tails
  // for every candidate (quadratic on long repeated text).
  let fullSuffix = 0;
  while (fullSuffix < oldText.length && fullSuffix < nextText.length
    && oldText[oldText.length - fullSuffix - 1] === nextText[nextText.length - fullSuffix - 1]) fullSuffix += 1;
  const earliest = Math.max(0, oldText.length - removed - fullSuffix);
  const start = Math.max(earliest, Math.min(prefix, target));
  return { start, oldEnd: start + removed, nextEnd: start + inserted };
}

/** Preserve native-authored marks while the platform TextInput edits its plain-text projection. */
function replaceNativeComposerTextCandidate(
  document: ComposerDocument,
  nextText: string,
  selection: { readonly start: number; readonly end: number } | null = null,
): ComposerDocument {
  const oldText = composerDocumentToPlainText(document);
  if (nextText === oldText) return document;
  const bounds = resolveNativeEditBounds(oldText, nextText, selection);
  const prefix = bounds.start;
  const suffix = oldText.length - bounds.oldEnd;
  const nestedLeaf = findNestedEditableLeaf(document, bounds.start, bounds.oldEnd);
  if (nestedLeaf) {
    const localStart = bounds.start - nestedLeaf.start;
    const localEnd = bounds.oldEnd - nestedLeaf.start;
    const inserted = nextText.slice(bounds.start, bounds.nextEnd);
    const leafText = composerDocumentToPlainText({ version: 1, blocks: [nestedLeaf.block] });
    const nextLeafText = `${leafText.slice(0, localStart)}${inserted}${leafText.slice(localEnd)}`;
    const blocks = nestedLeaf.block.type === "code-block"
      ? [{ ...nestedLeaf.block, text: nextLeafText }]
      : replaceNativeComposerText({ version: 1, blocks: [nestedLeaf.block] }, nextLeafText, {
        start: localStart, end: localEnd,
      }).blocks;
    const updated = nestedLeaf.replace(blocks);
    return composerDocumentToPlainText(updated) === nextText ? updated : document;
  }
  const paragraphScope = findNestedParagraphScope(document, bounds.start, bounds.oldEnd);
  if (paragraphScope) {
    const localStart = bounds.start - paragraphScope.start;
    const localEnd = bounds.oldEnd - paragraphScope.start;
    const scopeText = composerDocumentToPlainText({ version: 1, blocks: paragraphScope.blocks });
    const inserted = nextText.slice(bounds.start, bounds.nextEnd);
    const nextScopeText = `${scopeText.slice(0, localStart)}${inserted}${scopeText.slice(localEnd)}`;
    const changed = replaceNativeComposerText({ version: 1, blocks: paragraphScope.blocks }, nextScopeText, {
      start: localStart, end: localEnd,
    });
    const updated = paragraphScope.replace(changed.blocks);
    return composerDocumentToPlainText(updated) === nextText ? updated : document;
  }
  const characters = textCharacters(document);
  if (characters === null) {
    const ranges = document.blocks.map((block, index) => {
      const preceding = document.blocks.slice(0, index);
      const start = preceding.reduce((length, candidate) =>
        length + composerDocumentToPlainText({ version: 1, blocks: [candidate] }).length + 1, 0);
      return { start, end: start + composerDocumentToPlainText({ version: 1, blocks: [block] }).length };
    });
    const oldEnd = oldText.length - suffix;
    const startIndex = ranges.findIndex(range => range.end >= prefix);
    const endIndex = ranges.findLastIndex(range => range.start <= oldEnd);
    if (startIndex < 0 || endIndex < startIndex) return document;
    const first = document.blocks[startIndex]!;
    const last = document.blocks[endIndex]!;
    if (startIndex === endIndex) {
      const blockText = composerDocumentToPlainText({ version: 1, blocks: [first] });
      const nextBlockText = blockText.slice(0, prefix - ranges[startIndex]!.start)
        + nextText.slice(prefix, nextText.length - suffix)
        + blockText.slice(oldEnd - ranges[startIndex]!.start);
      if (first.type === "code-block") return {
        version: 1,
        blocks: document.blocks.map((candidate, position) => position === startIndex
          ? { ...first, text: nextBlockText } : candidate),
      };
      if (first.type !== "paragraph") return document;
      const changed = replaceNativeComposerText({ version: 1, blocks: [first] }, nextBlockText, {
        start: prefix - ranges[startIndex]!.start,
        end: oldEnd - ranges[startIndex]!.start,
      });
      return { version: 1, blocks: [
        ...document.blocks.slice(0, startIndex), ...changed.blocks, ...document.blocks.slice(startIndex + 1),
      ] };
    }
    // A plain TextInput cannot safely edit through a quote, list or divider.
    // Keep the durable structured draft intact rather than silently flattening it.
    if (document.blocks.slice(startIndex, endIndex + 1).some(block => block.type !== "paragraph")) return document;
    const firstCharacters = textCharacters({ version: 1, blocks: [first] })!;
    const lastCharacters = textCharacters({ version: 1, blocks: [last] })!;
    const inheritedMarks = firstCharacters[prefix - ranges[startIndex]!.start - 1]?.marks ?? [];
    const inserted = nextText.slice(prefix, nextText.length - suffix).split("")
      .map(character => character === "\n" ? null : { text: character, marks: inheritedMarks });
    const combined: readonly (Character | null)[] = [
      ...firstCharacters.slice(0, prefix - ranges[startIndex]!.start),
      ...inserted,
      ...lastCharacters.slice(oldEnd - ranges[endIndex]!.start),
    ];
    const paragraphs = documentFromEditedLines(combined).blocks;
    return { version: 1, blocks: [
      ...document.blocks.slice(0, startIndex), ...paragraphs, ...document.blocks.slice(endIndex + 1),
    ] };
  }
  const previousLink = characters[prefix - 1]?.link;
  const nextLink = characters[bounds.oldEnd]?.link;
  const replacedLink = characters.slice(prefix, bounds.oldEnd);
  const inheritedLink = previousLink && previousLink === nextLink
    ? previousLink
    : replacedLink.length > 0 && replacedLink.every(character => character.link === replacedLink[0]?.link)
      && (previousLink === replacedLink[0]?.link || nextLink === replacedLink[0]?.link)
      ? replacedLink[0]?.link : undefined;
  const inheritedMarks = inheritedLink && replacedLink[0]?.link === inheritedLink
    ? replacedLink[0].marks
    : characters[prefix - 1]?.marks ?? characters[prefix]?.marks ?? [];
  const inserted = nextText.slice(prefix, nextText.length - suffix).split("")
    .map(text => text === "\n" ? null : { text, marks: inheritedMarks, link: inheritedLink });
  return documentFromEditedLines([
    ...characters.slice(0, prefix),
    ...inserted,
    ...characters.slice(characters.length - suffix),
  ]);
}

/** The native projection must never disagree with the durable Composer draft. */
export function replaceNativeComposerText(
  document: ComposerDocument,
  nextText: string,
  selection: { readonly start: number; readonly end: number } | null = null,
): ComposerDocument {
  const updated = replaceNativeComposerTextCandidate(document, nextText, selection);
  return composerDocumentToPlainText(updated) === nextText ? updated : document;
}

/** A Composer action inserts at the native cursor or replaces its selection. */
export function insertNativeComposerText(
  document: ComposerDocument,
  text: string,
  selection: { readonly start: number; readonly end: number } | null,
): { readonly document: ComposerDocument; readonly cursor: number } | null {
  const plain = composerDocumentToPlainText(document);
  const start = selection === null ? plain.length : Math.max(0, Math.min(selection.start, plain.length));
  const end = selection === null ? plain.length : Math.max(start, Math.min(selection.end, plain.length));
  const next = `${plain.slice(0, start)}${text}${plain.slice(end)}`;
  const updated = replaceNativeComposerText(document, next, { start, end });
  if (updated === document && next !== plain) return null;
  return { document: updated, cursor: start + text.length };
}

type EditableTextSpan = { readonly characters: Character[]; readonly start: number; readonly end: number };

/** Map a native selection to text leaves while protecting generated and atomic content. */
function collectEditableTextSpans(
  document: ComposerDocument,
  start: number,
  end: number,
): Map<string, EditableTextSpan> | null {
  if (start < 0 || end <= start || end > composerDocumentToPlainText(document).length) return null;
  const spans = new Map<string, EditableTextSpan>();
  let protectedSelection = false;
  const overlaps = (from: number, to: number) => start < to && end > from;
  const collect = (blocks: readonly ComposerBlockNode[], initialOffset: number, path: string): void => {
    let offset = initialOffset;
    blocks.forEach((block, index) => {
      const key = `${path}.${index}`;
      const length = blockLength(block);
      if (block.type === "paragraph") {
        const localStart = Math.max(0, start - offset);
        const localEnd = Math.min(length, end - offset);
        if (localStart < localEnd) {
          const characters = textCharacters({ version: 1, blocks: [block] })!;
          if (characters.slice(localStart, localEnd).some(character => character.atomic !== undefined)) {
            protectedSelection = true;
          } else {
            spans.set(key, { characters, start: localStart, end: localEnd });
          }
        }
      } else if (block.type === "quote") {
        if (length === 0 && start <= offset && end > offset) protectedSelection = true;
        collect(block.children, offset, `${key}.quote`);
      } else if (block.type === "list") {
        if (length === 0 && start <= offset && end > offset) protectedSelection = true;
        let itemOffset = offset;
        block.items.forEach((item, itemIndex) => {
          const marker = block.ordered ? `${(block.start ?? 1) + itemIndex}. ` : "- ";
          if (overlaps(itemOffset, itemOffset + marker.length)) protectedSelection = true;
          collect(item.children, itemOffset + marker.length, `${key}.item.${itemIndex}`);
          const contentLength = item.children.reduce((sum, child) => sum + blockLength(child) + 1, -1);
          itemOffset += marker.length + Math.max(0, contentLength) + 1;
        });
      } else if (length === 0 ? start <= offset && end > offset : overlaps(offset, offset + length)) {
        protectedSelection = true;
      }
      offset += length + 1;
    });
  };
  collect(document.blocks, 0, "root");
  return protectedSelection || spans.size === 0 ? null : spans;
}

function mapEditableParagraphs(
  document: ComposerDocument,
  spans: ReadonlyMap<string, EditableTextSpan>,
  edit: (character: Character, selected: boolean) => Character,
): ComposerDocument {
  const format = (block: ComposerBlockNode, key: string): ComposerBlockNode => {
    if (block.type === "paragraph") {
      const span = spans.get(key);
      if (!span) return block;
      return documentFromCharacters(span.characters.map((character, index) =>
        edit(character, index >= span.start && index < span.end))).blocks[0]!;
    }
    if (block.type === "quote") return {
      ...block,
      children: block.children.map((child, index) => format(child, `${key}.quote.${index}`)),
    };
    if (block.type === "list") return {
      ...block,
      items: block.items.map((item, itemIndex) => ({
        ...item,
        children: item.children.map((child, index) => format(child, `${key}.item.${itemIndex}.${index}`)),
      })),
    };
    return block;
  };
  return { version: 1, blocks: document.blocks.map((block, index) => format(block, `root.${index}`)) };
}

export function toggleNativeComposerMark(
  document: ComposerDocument,
  start: number,
  end: number,
  mark: Mark,
): ComposerDocument | null {
  const spans = collectEditableTextSpans(document, start, end);
  if (spans === null) return null;
  const remove = [...spans.values()].every(span => span.characters.slice(span.start, span.end)
    .every(character => character.marks.includes(mark)));
  return mapEditableParagraphs(document, spans, (character, selected) => {
    if (!selected) return character;
    const marks = remove
      ? character.marks.filter(candidate => candidate !== mark)
      : [...new Set([...character.marks, mark])];
    return { ...character, marks };
  });
}

/** Link selected text leaves without flattening their paragraph or quote structure. */
export function setNativeComposerLink(
  document: ComposerDocument,
  start: number,
  end: number,
  href: string | null,
): ComposerDocument | null {
  const spans = collectEditableTextSpans(document, start, end);
  if (spans === null) return null;
  if (href === null && [...spans.values()].every(span => span.characters.slice(span.start, span.end)
    .every(character => character.link === undefined))) return document;
  const link: ComposerLinkInline | undefined = href === null ? undefined : { type: "link", href, children: [] };
  return mapEditableParagraphs(document, spans, (character, selected) => selected ? { ...character, link } : character);
}

export function nativeComposerLinkAt(document: ComposerDocument, start: number, end: number): string | null {
  const spans = collectEditableTextSpans(document, start, end);
  if (spans === null) return null;
  const selected = [...spans.values()].flatMap(span => span.characters.slice(span.start, span.end));
  const href = selected[0]?.link?.href;
  return href && selected.every(character => character.link?.href === href) ? href : null;
}

export function normalizeNativeComposerLinkAddress(address: string): string | null {
  const trimmed = address.trim();
  if (trimmed.length === 0) return null;
  const candidate = /^[a-z][a-z\d+.-]*:/iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname
      || url.username || url.password) return null;
    // Shared AppServer input serializes links as Markdown destinations.
    return url.href.replaceAll("(", "%28").replaceAll(")", "%29");
  } catch {
    return null;
  }
}

export function hasNativeComposerMarks(document: ComposerDocument): boolean {
  const inlineHasMarks = (inline: ComposerInline): boolean => inline.type === "text"
    ? (inline.marks?.length ?? 0) > 0
    : inline.type === "link" && inline.children.some(child => (child.marks?.length ?? 0) > 0);
  const blockHasMarks = (block: ComposerBlockNode): boolean => block.type === "paragraph"
    ? block.children.some(inlineHasMarks)
    : block.type === "quote" ? block.children.some(blockHasMarks)
      : block.type === "list" && block.items.some(item => item.children.some(blockHasMarks));
  return document.blocks.some(blockHasMarks);
}

export interface NativeComposerVisualRun {
  readonly text: string;
  readonly marks: readonly Mark[];
  readonly href?: string;
}

/** A read-only projection that keeps marks while reproducing the shared plain-text view. */
export function projectNativeComposerPreviewRuns(document: ComposerDocument): readonly NativeComposerVisualRun[] {
  const runs: NativeComposerVisualRun[] = [];
  const push = (text: string, marks: readonly Mark[] = [], href?: string) => {
    runs.push(href === undefined ? { text, marks } : { text, marks, href });
  };
  const appendBlocks = (blocks: readonly ComposerBlockNode[]) => {
    blocks.forEach((block, blockIndex) => {
      if (blockIndex > 0) push("\n");
      switch (block.type) {
        case "paragraph":
          for (const inline of block.children) {
            if (inline.type === "text") push(inline.text, inline.marks ?? []);
            else if (inline.type === "link") inline.children.forEach(child => push(child.text, child.marks ?? [], inline.href));
            else push(composerDocumentToPlainText({ version: 1, blocks: [{ type: "paragraph", children: [inline] }] }));
          }
          break;
        case "code-block": push(block.text); break;
        case "divider": push("---"); break;
        case "quote": appendBlocks(block.children); break;
        case "list":
          block.items.forEach((item, itemIndex) => {
            if (itemIndex > 0) push("\n");
            push(block.ordered ? `${(block.start ?? 1) + itemIndex}. ` : "- ");
            appendBlocks(item.children);
          });
          break;
      }
    });
  };
  appendBlocks(document.blocks);
  return runs;
}

/** Every editable text projection uses the same attributed runs on iOS. */
export function projectNativeComposerVisualRuns(document: ComposerDocument): readonly NativeComposerVisualRun[] {
  return projectNativeComposerPreviewRuns(document);
}
