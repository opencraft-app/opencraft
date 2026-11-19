import type { BrowserAnnotation, BrowserAnnotationAnchor } from "@opencraft/browser-core";

/** Lowest free number in a page, so removed comments free their number. */
export function nextAnnotationNumber(existing: readonly Pick<BrowserAnnotation, "number">[]): number {
  const used = new Set(existing.map((item) => item.number));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

export function createAnnotation(input: {
  readonly id: string;
  readonly tabId: string;
  readonly anchor: BrowserAnnotationAnchor;
  readonly comment: string;
  readonly screenshot?: string | null;
  readonly surface?: BrowserAnnotation["surface"];
  readonly existing: readonly BrowserAnnotation[];
}): BrowserAnnotation {
  // Numbers label "## User Comment N" in one message, so they are unique per
  // draft even across pages and tabs.
  return {
    id: input.id,
    number: nextAnnotationNumber(input.existing),
    tabId: input.tabId,
    anchor: input.anchor,
    comment: input.comment.trim(),
    screenshot: input.screenshot ?? null,
    ...(input.surface ? { surface: input.surface } : {}),
  };
}

export function annotationMarks(annotations: readonly BrowserAnnotation[], url: string | null) {
  return annotations.flatMap((item) =>
    (item.selections ?? [{ id: item.id, label: String(item.number), anchor: item.anchor }])
      .filter((selection) => url !== null && selection.anchor.url === url)
      .map(({ anchor, label, id }) => ({
        ...anchor.rect,
        markerId: `${item.id}/${id}`,
        state: "saved" as const,
        kind: anchor.kind,
        selectionRects: anchor.selectionRects,
        documentGeneration: anchor.kind !== "element" ? anchor.documentGeneration : undefined,
        label,
        fixed: anchor.isFixed,
        selector: anchor.kind === "element" ? (anchor.selector ?? undefined) : undefined,
        targetKey: anchor.kind === "element" ? (anchor.bindingKey ?? "expired") : undefined,
      })),
  );
}

/** The caller retains issued labels, including deleted targets, for this edit. */
export function nextAnnotationSelectionLabel(number: number, issuedLabels: readonly string[]): string {
  if (!Number.isSafeInteger(number) || number < 1 || number > 8) throw new Error("Invalid annotation number");
  let ordinal = 0;
  for (const label of issuedLabels) {
    const suffix = label.startsWith(String(number)) ? label.slice(String(number).length) : "";
    if (!/^[A-Z]{1,8}$/.test(suffix)) continue;
    let value = 0;
    for (const letter of suffix) value = value * 26 + letter.charCodeAt(0) - 64;
    ordinal = Math.max(ordinal, value);
  }
  let value = ordinal + 1,
    suffix = "";
  while (value > 0) {
    value--;
    suffix = String.fromCharCode(65 + (value % 26)) + suffix;
    value = Math.floor(value / 26);
  }
  return `${number}${suffix}`;
}

/** Migration is evidence-only: it does not refresh a binding or capture images. */
export function upgradeAnnotation(annotation: BrowserAnnotation): BrowserAnnotation {
  if (annotation.schemaVersion === 2) return annotation;
  return {
    ...annotation,
    schemaVersion: 2,
    selections: [{ id: `${annotation.id}:primary`, label: `${annotation.number}A`, anchor: annotation.anchor }],
    styleIntents: [],
    textReplacements: [],
    evidence: [],
  };
}
