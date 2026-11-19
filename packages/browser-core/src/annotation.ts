/**
 * Browser annotation. Users point at an element in the browser panel and
 * attach a comment; the agent receives a structured, redacted anchor.
 *
 * The picker runs on the page side (Hands worker for the remote browser,
 * injected bridge for desktop). Clients only send a point on the frame they
 * see plus that frame's size, so page zoom and device emulation never need
 * to be known by the client (the page divides by its own innerWidth).
 */

export type BrowserAnnotationPoint = {
  /** Point in frame pixels of the image the user saw. */
  readonly x: number;
  readonly y: number;
  /** Size of that frame. Used to map to page CSS pixels. */
  readonly frameWidth: number;
  readonly frameHeight: number;
};

export type BrowserAnnotationPickRequest = {
  readonly point: BrowserAnnotationPoint;
  /** 0 = deepest meaningful hit; positive values walk up ancestors (选上一层). */
  readonly depth?: number;
  /** Revisit the original target after scrolling; missing/ambiguous targets fail. */
  readonly selector?: string;
};

export interface BrowserAnnotationRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserAnnotationAnchor {
  readonly kind: "element" | "region" | "text";
  /** Exact, uncollapsed Range text; never populated for sensitive controls. */
  readonly selectedText?: string;
  readonly textLocator?: BrowserAnnotationTextLocator;
  /** Bounded, captured line geometry; not a live Range or reflow promise. */
  readonly selectionRects?: readonly BrowserAnnotationRect[];
  readonly framePath?: readonly BrowserAnnotationFrameSegment[];
  readonly documentGeneration?: string;
  readonly elementName?: string;
  readonly elementMetadata?: Readonly<Record<string, string | number | boolean | null>>;
  /** Ephemeral element identity, never rebound after document replacement. */
  readonly bindingKey?: string;
  readonly url: string;
  readonly title: string;
  /** Preview-bridge document revision at pick time. */
  readonly revision: number;
  /** Bridge element ref usable with browser_use while revision is current. */
  readonly ref: string;
  /** Unique CSS selector, or null when no short unique selector exists. */
  readonly selector: string | null;
  /** Nearest four tags, outermost first, e.g. `main > form > div > button`. */
  readonly elementPath: string;
  readonly tag: string;
  readonly role: string | null;
  readonly name: string | null;
  /** Own visible text, whitespace-collapsed, at most 80 chars. Null when redacted. */
  readonly text: string | null;
  /** Nearby text from the parent, at most 80 chars. */
  readonly nearbyText: string | null;
  /** Number of direct element children. */
  readonly childCount: number;
  readonly sensitive: boolean;
  /** Document CSS pixels (scroll-independent). */
  readonly rect: BrowserAnnotationRect;
  readonly isFixed: boolean;
  /** `file:line[:col]` from the nearest data-oc-source ancestor, if any. */
  readonly source: string | null;
  readonly frame: "main" | "child";
}

export interface BrowserAnnotationTextLocator {
  readonly startPath: readonly number[];
  readonly startOffset: number;
  readonly endPath: readonly number[];
  readonly endOffset: number;
}

export interface BrowserAnnotationFrameSegment {
  readonly selector: string | null;
  readonly documentGeneration: string;
  readonly frameId?: string;
  readonly url?: string;
}

export interface BrowserAnnotationSelection {
  readonly id: string;
  /** Stable visible label, e.g. 1A; deleting a sibling never renumbers it. */
  readonly label: string;
  readonly anchor: BrowserAnnotationAnchor;
}

export const BROWSER_ANNOTATION_STYLE_PROPERTIES = [
  "color",
  "background-color",
  "font-size",
  "font-weight",
  "line-height",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "gap",
  "row-gap",
  "column-gap",
  "border-radius",
  "width",
  "height",
] as const;
export type BrowserAnnotationStyleProperty = (typeof BROWSER_ANNOTATION_STYLE_PROPERTIES)[number];
export interface BrowserAnnotationStyleIntent {
  readonly selectionId: string;
  readonly property: BrowserAnnotationStyleProperty;
  readonly observedComputedValue: string;
  readonly requestedValue: string;
}
export interface BrowserAnnotationTextReplacement {
  readonly selectionId: string;
  readonly beforeText: string;
  /** Empty means explicit deletion; whitespace and Unicode are preserved. */
  readonly afterText: string;
}
export interface BrowserAnnotationEvidence {
  readonly id: string;
  readonly selectionIds: readonly string[];
  readonly dataUrl: string;
  readonly kind: "target" | "context";
  readonly preface?: string;
}

export interface BrowserAnnotationPick {
  readonly anchor: BrowserAnnotationAnchor;
  /** Target box as fractions (0..1) of the current viewport, for placing UI. */
  readonly viewport: { readonly top: number; readonly bottom: number; readonly left?: number; readonly right?: number };
  /** Depth actually used after clamping. */
  readonly depth: number;
  readonly maxDepth: number;
}

export interface BrowserAnnotation {
  readonly schemaVersion?: 2;
  readonly selections?: readonly BrowserAnnotationSelection[];
  readonly styleIntents?: readonly BrowserAnnotationStyleIntent[];
  readonly textReplacements?: readonly BrowserAnnotationTextReplacement[];
  readonly evidence?: readonly BrowserAnnotationEvidence[];
  readonly id: string;
  /** Per page, from 1. */
  readonly number: number;
  readonly tabId: string;
  readonly anchor: BrowserAnnotationAnchor;
  readonly comment: string;
  /** User-reviewed target crop, or a legacy page screenshot; null for text-only comments. */
  readonly screenshot: string | null;
  /** Where it was made. File previews are sandboxed: no browser tool access. */
  readonly surface?: "browser" | "file-preview";
}

export type BrowserAnnotationMark = BrowserAnnotationRect & {
  /** Host-owned ephemeral identity, used only to reopen an existing draft. */
  readonly markerId?: string;
  readonly selectionRects?: readonly BrowserAnnotationRect[];
  readonly caption?: string;
  readonly state?: "hover" | "current" | "selected" | "saved";
  readonly kind?: "element" | "region" | "text";
  /** Snapshot marks require a generation registered at selection, never during replay. */
  readonly documentGeneration?: string;
  readonly selector?: string;
  readonly targetKey?: string;
  readonly label?: string;
  /** Dashed candidate box (hover / first tap). */
  readonly pending?: boolean;
  readonly fixed?: boolean;
};

export interface BrowserAnnotationPointerHandlers {
  readonly mode?: "element" | "region" | "text" | "browse";
  drag?(start: BrowserAnnotationPoint, end: BrowserAnnotationPoint): void;
  /** Mouse hover (not touch). Throttled to one per frame. */
  hover?(point: BrowserAnnotationPoint): void;
  tap(point: BrowserAnnotationPoint, pointer: "mouse" | "touch" | "pen"): void;
}

/** Page-side picker plus page-hosted overlay. Implemented per surface host. */
export interface BrowserAnnotator {
  readonly capabilities?: BrowserAnnotationCapabilities;
  pickRegion?(input: BrowserAnnotationDragRequest): Promise<BrowserAnnotationPick>;
  pickText?(input: BrowserAnnotationDragRequest): Promise<BrowserAnnotationPick>;
  readStyles?(anchor: BrowserAnnotationAnchor): Promise<Readonly<Record<string, string>>>;
  preview?(input: BrowserAnnotationPreviewRequest): Promise<void>;
  clearPreview?(): Promise<void>;
  pick(input: BrowserAnnotationPickRequest): Promise<BrowserAnnotationPick>;
  /** Draw boxes (document CSS px) in the page overlay; empty clears. */
  mark(boxes: readonly BrowserAnnotationMark[], color?: string): Promise<void>;
  /** Hit current page-hosted marker geometry; never approximate from stale client rectangles. */
  hitMark?(point: BrowserAnnotationPoint): Promise<readonly string[]>;
  /** PNG data URL of the page including the overlay. */
  capture(): Promise<string>;
  /**
   * Route taps on the page surface to the annotator instead of the page.
   * Scrolling (wheel, touch drag) still reaches the page. Returns release.
   */
  intercept(handlers: BrowserAnnotationPointerHandlers): () => void;
  /** Scroll the page down by this fraction of its viewport height (negative: up). */
  reveal?(fraction: number): Promise<void>;
}

export interface BrowserAnnotationCapabilities {
  readonly region: boolean;
  readonly text: boolean;
  readonly multiSelect: boolean;
  readonly styles: boolean;
  readonly capture: boolean;
  readonly preview: boolean;
  readonly sameOriginFrames: boolean;
  readonly openShadow: boolean;
}

export interface BrowserAnnotationDragRequest {
  readonly start: BrowserAnnotationPoint;
  readonly end: BrowserAnnotationPoint;
}

export interface BrowserAnnotationPreviewRequest {
  readonly changes: readonly {
    readonly anchor: BrowserAnnotationAnchor;
    readonly property?: BrowserAnnotationStyleProperty;
    readonly value?: string;
    readonly text?: string;
  }[];
  readonly original?: boolean;
}

export const BROWSER_ANNOTATION_TEXT_LIMIT = 80;

export function collapseAnnotationText(
  value: string | null | undefined,
  limit = BROWSER_ANNOTATION_TEXT_LIMIT,
): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (text === "") return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
