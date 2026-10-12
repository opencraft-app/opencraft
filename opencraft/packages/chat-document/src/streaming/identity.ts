import type {
  ChatDocumentNode,
  ChatDocumentSnapshot,
  ChatTextSegment,
} from "../model";

export interface IdentityReconciliationResult {
  readonly nodes: readonly ChatDocumentNode[];
  readonly nextIdentity: number;
}

let wordSegmenter: { segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }> } | undefined;
const wordSegmentsByNode = new WeakMap<ChatDocumentNode, readonly string[]>();
const settledNodes = new WeakMap<ChatDocumentNode, ChatDocumentNode>();

function wordsForNode(node: Extract<ChatDocumentNode, { kind: "text" | "reference" | "color-swatch" }>): readonly string[] {
  const cached = wordSegmentsByNode.get(node);
  if (cached !== undefined) return cached;
  const words = segmentWords(node.text);
  wordSegmentsByNode.set(node, words);
  return words;
}

/** Entering is a one-commit observation, not a property of immutable syntax. */
function settledNode(node: ChatDocumentNode): ChatDocumentNode {
  const cached = settledNodes.get(node);
  if (cached !== undefined) return cached;
  let result = node;
  if (node.kind === "text" || node.kind === "reference" || node.kind === "color-swatch") {
    if (node.segments.some((segment) => segment.entering)) {
      result = { ...node, segments: node.segments.map((segment) => segment.entering ? { ...segment, entering: false } : segment) };
    }
  } else if (node.kind === "table") {
    result = { ...node, header: node.header.map((cell) => cell.map(settledNode)),
      rows: node.rows.map((row) => row.map((cell) => cell.map(settledNode))) };
  } else if ("children" in node) {
    const children = node.children.map(settledNode);
    if (children.some((child, index) => child !== node.children[index])) result = withChildren(node, children);
  }
  settledNodes.set(node, result);
  settledNodes.set(result, result);
  return result;
}

function compatible(left: ChatDocumentNode | undefined, right: ChatDocumentNode): boolean {
  if (left === undefined || left.kind !== right.kind) return false;
  if (left.kind === "math" && right.kind === "math") return left.display === right.display;
  if (left.kind === "directive" && right.kind === "directive") return left.name === right.name;
  return true;
}

function firstWord(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  return (trimmed.split("\n", 1)[0]?.match(/\S+/u)?.[0] ?? trimmed).slice(0, 96);
}

function nodeText(node: ChatDocumentNode): string {
  if (node.kind === "text" || node.kind === "reference" || node.kind === "color-swatch") return node.text;
  if (node.kind === "inline-code") return node.code;
  if (node.kind === "math") return node.source;
  if (node.kind === "image") return node.alt;
  if (node.kind === "directive" || node.kind === "unknown") return node.raw;
  if (node.kind === "code-fence") return node.code;
  if (node.kind === "table") return node.markdownSource;
  return "children" in node ? node.children.map(nodeText).join("") : "";
}

/**
 * Mirrors Codex's syntax-class key: semantic token shape + first meaningful
 * word, with occurrence counted only among siblings of the same class.
 * Source offsets are deliberately excluded because a prefix insertion moves
 * every later token without changing its identity.
 */
function semanticClass(node: ChatDocumentNode): string {
  switch (node.kind) {
    case "code-fence":
      // Codex keys a fence by its delimiter, not by a still-streaming language.
      return "code-fence:fence";
    case "link":
      return `link:${node.href}:${firstWord(nodeText(node))}`;
    case "image":
      return `image:${node.src}:${firstWord(node.alt)}`;
    case "math":
      return `math:${node.display ? "block" : "inline"}:${firstWord(node.source)}`;
    case "directive": {
      const attributes = Object.entries(node.attributes)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => `${name}=${value}`)
        .join("&");
      return `directive:${node.name}:${attributes}`;
    }
    case "horizontal-rule": return "horizontal-rule:raw";
    case "line-break": return "line-break:raw";
    case "unknown": return `unknown:${node.tokenType}:${firstWord(node.raw)}`;
    case "list": return `list:${node.ordered ? "ordered" : "unordered"}:${firstWord(nodeText(node))}`;
    default: return `${node.kind}:${firstWord(nodeText(node))}`;
  }
}

function compatibleGrowingClass(left: ChatDocumentNode, right: ChatDocumentNode): boolean {
  if (!compatible(left, right)) return false;
  const previousClass = semanticClass(left);
  const nextClass = semanticClass(right);
  return previousClass.length > 0
    && (nextClass.startsWith(previousClass) || previousClass.startsWith(nextClass));
}

function segmentWords(text: string): readonly string[] {
  // Codex deliberately bypasses Intl.Segmenter for ASCII. Consecutive
  // alphanumerics form a segment and punctuation/whitespace belongs to the
  // segment immediately before it. This keeps a growing `word, ` on one key
  // instead of making punctuation briefly mount as a separate fading span.
  if (/^[\x00-\x7f]*$/u.test(text)) {
    const result: string[] = [];
    let index = 0;
    const isAlphanumeric = (code: number) => (
      (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
    );
    while (index < text.length) {
      if (isAlphanumeric(text.charCodeAt(index))) {
        const start = index;
        while (index < text.length && isAlphanumeric(text.charCodeAt(index))) index += 1;
        result.push(text.slice(start, index));
        continue;
      }
      const lastIndex = Math.max(result.length - 1, 0);
      result[lastIndex] = `${result[lastIndex] ?? ""}${text[index] ?? ""}`;
      index += 1;
    }
    return result;
  }
  try {
    const Segmenter = (Intl as unknown as {
      Segmenter?: new (locale?: string | string[], options?: { granularity: "word" }) => {
        segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }>;
      };
    }).Segmenter;
    if (Segmenter !== undefined) {
      const result: string[] = [];
      wordSegmenter ??= new Segmenter(undefined, { granularity: "word" });
      for (const part of wordSegmenter.segment(text)) {
        if (part.isWordLike || result.length === 0) result.push(part.segment);
        else result[result.length - 1] = `${result[result.length - 1] ?? ""}${part.segment}`;
      }
      if (result.length > 0) return result;
    }
  } catch {
    // The regex fallback works in older native JavaScript runtimes.
  }
  return text.match(/\s*\S+(?:\s+|$)/gu) ?? (text.length === 0 ? [] : [text]);
}

function collectTextSegments(nodes: readonly ChatDocumentNode[]): ChatTextSegment[] {
  const result: ChatTextSegment[] = [];
  for (const node of nodes) {
    if (node.kind === "text" || node.kind === "reference" || node.kind === "color-swatch") {
      result.push(...node.segments);
      continue;
    }
    if (node.kind === "table") {
      for (const cell of node.header) result.push(...collectTextSegments(cell));
      for (const row of node.rows) for (const cell of row) result.push(...collectTextSegments(cell));
      continue;
    }
    if ("children" in node) result.push(...collectTextSegments(node.children));
  }
  return result;
}

function collectSegmentContents(nodes: readonly ChatDocumentNode[]): string[] {
  const result: string[] = [];
  for (const node of nodes) {
    if (node.kind === "text" || node.kind === "reference" || node.kind === "color-swatch") {
      result.push(...wordsForNode(node));
      continue;
    }
    if (node.kind === "table") {
      for (const cell of node.header) result.push(...collectSegmentContents(cell));
      for (const row of node.rows) for (const cell of row) result.push(...collectSegmentContents(cell));
      continue;
    }
    if ("children" in node) result.push(...collectSegmentContents(node.children));
  }
  return result;
}

/** Source-equivalent global fade-segment reconciliation from Codex. */
function reconcileGlobalSegments(
  documentId: string,
  segments: readonly string[],
  previous: readonly ChatTextSegment[],
  streaming: boolean,
  identity: { value: number },
): readonly ChatTextSegment[] {
  const available = new Set(previous.keys());
  const indexesByContent = new Map<string, number[]>();
  for (let index = previous.length - 1; index >= 0; index -= 1) {
    const prior = previous[index];
    if (prior === undefined) continue;
    const indexes = indexesByContent.get(prior.text) ?? [];
    indexes.push(index);
    indexesByContent.set(prior.text, indexes);
  }
  return segments.map((segment, index) => {
    const prior = previous[index];
    if (
      prior !== undefined
      && available.has(index)
      && (prior.text === segment || (prior.text.length > 0 && segment.startsWith(prior.text)))
    ) {
      available.delete(index);
      return { key: prior.key, text: segment, entering: false };
    }
    const sameContentIndexes = indexesByContent.get(segment);
    let candidateIndex = sameContentIndexes?.pop();
    while (candidateIndex !== undefined && !available.has(candidateIndex)) candidateIndex = sameContentIndexes?.pop();
    const candidate = candidateIndex === undefined ? undefined : previous[candidateIndex];
    if (candidateIndex !== undefined && candidate !== undefined) {
      available.delete(candidateIndex);
      return { key: candidate.key, text: segment, entering: false };
    }
    return {
      key: `${documentId}:segment:${identity.value++}`,
      text: segment,
      entering: streaming,
    };
  });
}

function childNodes(node: ChatDocumentNode): readonly ChatDocumentNode[] | null {
  return "children" in node ? node.children : null;
}

function withChildren(node: ChatDocumentNode, children: readonly ChatDocumentNode[]): ChatDocumentNode {
  if (!("children" in node)) return node;
  return { ...node, children } as ChatDocumentNode;
}

function reconcileTable(
  node: Extract<ChatDocumentNode, { kind: "table" }>,
  previous: Extract<ChatDocumentNode, { kind: "table" }> | undefined,
  documentId: string,
  identity: { value: number },
  streaming: boolean,
  segmentAssignments: { readonly values: readonly ChatTextSegment[]; cursor: number },
): ChatDocumentNode {
  const reconcileCells = (
    cells: readonly (readonly ChatDocumentNode[])[],
    priorCells: readonly (readonly ChatDocumentNode[])[] | undefined,
  ) => cells.map((cell, index) => reconcileNodeList(
    cell,
    priorCells?.[index] ?? [],
    documentId,
    identity,
    streaming,
    segmentAssignments,
  ));
  return {
    ...node,
    header: reconcileCells(node.header, previous?.header),
    rows: node.rows.map((row, rowIndex) => reconcileCells(row, previous?.rows[rowIndex])),
  };
}

function reconcileNodeList(
  nodes: readonly ChatDocumentNode[],
  previous: readonly ChatDocumentNode[],
  documentId: string,
  identity: { value: number },
  streaming: boolean,
  segmentAssignments: { readonly values: readonly ChatTextSegment[]; cursor: number },
): readonly ChatDocumentNode[] {
  const previousBySlot = new Map<string, ChatDocumentNode>();
  const previousOccurrences = new Map<string, number>();
  for (const previousNode of previous) {
    const className = semanticClass(previousNode);
    const occurrence = previousOccurrences.get(className) ?? 0;
    previousOccurrences.set(className, occurrence + 1);
    previousBySlot.set(`${className}\0${occurrence}`, previousNode);
  }
  const currentOccurrences = new Map<string, number>();
  const usedPrevious = new Set<ChatDocumentNode>();

  return nodes.map((node, index) => {
    const className = semanticClass(node);
    const occurrence = currentOccurrences.get(className) ?? 0;
    currentOccurrences.set(className, occurrence + 1);
    const exact = previousBySlot.get(`${className}\0${occurrence}`);
    const positional = previous[index];
    const prior = exact !== undefined && compatible(exact, node) && !usedPrevious.has(exact)
      ? exact
      : positional !== undefined
        && !usedPrevious.has(positional)
        && compatibleGrowingClass(positional, node)
        ? positional
        : undefined;
    if (prior !== undefined) usedPrevious.add(prior);
    const stableKey = prior?.stableKey || `${documentId}:node:${identity.value++}`;
    if (node.kind === "text" || node.kind === "reference" || node.kind === "color-swatch") {
      const count = wordsForNode(node).length;
      const segments = segmentAssignments.values.slice(segmentAssignments.cursor, segmentAssignments.cursor + count);
      segmentAssignments.cursor += count;
      return {
        ...node,
        stableKey,
        segments,
      };
    }
    if (node.kind === "table") {
      return reconcileTable(
        { ...node, stableKey },
        prior?.kind === "table" ? prior : undefined,
        documentId,
        identity,
        streaming,
        segmentAssignments,
      );
    }
    const children = childNodes(node);
    if (children === null) return { ...node, stableKey };
    return withChildren(
      { ...node, stableKey } as ChatDocumentNode,
      reconcileNodeList(
        children,
        prior === undefined ? [] : childNodes(prior) ?? [],
        documentId,
        identity,
        streaming,
        segmentAssignments,
      ),
    );
  });
}

export function reconcileChatDocumentIdentity(
  documentId: string,
  nodes: readonly ChatDocumentNode[],
  previous: ChatDocumentSnapshot | null,
  nextIdentity: number,
  streaming: boolean,
  previousParsedNodes: readonly ChatDocumentNode[] = [],
): IdentityReconciliationResult {
  const identity = { value: nextIdentity };
  let prefixCount = 0;
  if (streaming && previous !== null) {
    while (prefixCount < nodes.length && prefixCount < previous.nodes.length
      && nodes[prefixCount] === previousParsedNodes[prefixCount]) prefixCount += 1;
  }
  const tailNodes = nodes.slice(prefixCount);
  const previousTail = previous?.nodes.slice(prefixCount) ?? [];
  const segments = reconcileGlobalSegments(
    documentId,
    collectSegmentContents(tailNodes),
    collectTextSegments(previousTail),
    streaming,
    identity,
  );
  return {
    nodes: [
      ...(previous?.nodes.slice(0, prefixCount).map(settledNode) ?? []),
      ...reconcileNodeList(
        tailNodes,
        previousTail,
        documentId,
        identity,
        streaming,
        { values: segments, cursor: 0 },
      ),
    ],
    nextIdentity: identity.value,
  };
}
