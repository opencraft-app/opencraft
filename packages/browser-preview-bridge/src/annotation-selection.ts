import type { BrowserAnnotationAnchor, BrowserAnnotationDragRequest, BrowserAnnotationPick, BrowserAnnotationPreviewRequest } from "@opencraft/browser-core";
import type { AnnotationPicker } from "./annotation-picker";

export interface AnnotationSelectionOptions {
  readonly picker: AnnotationPicker;
  readonly revision?: () => number;
  readonly ref?: (element: Element) => string;
  /** Host-owned policy and current control grant. Absent means read-only. */
  readonly authorizePreview?: () => boolean;
}
export interface AnnotationSelectionRuntime {
  pickRegion(request: BrowserAnnotationDragRequest): BrowserAnnotationPick;
  pickText(request: BrowserAnnotationDragRequest): BrowserAnnotationPick;
  readStyles(anchor: BrowserAnnotationAnchor): Readonly<Record<string, string>>;
  preview(request: BrowserAnnotationPreviewRequest): void;
  clearPreview(): void;
  dispose(): void;
}

/** Self-contained for frame-agent injection; picker is an explicit dependency. */
export function createAnnotationSelectionRuntime(document: Document, options: AnnotationSelectionOptions): AnnotationSelectionRuntime {
  const win = document.defaultView!, picker = options.picker;
  const properties = ["color", "background-color", "font-size", "font-weight", "line-height", "padding", "padding-top", "padding-right", "padding-bottom", "padding-left", "gap", "row-gap", "column-gap", "border-radius", "width", "height"];
  const attribute = `data-oc-preview-${(win.crypto.randomUUID?.() ?? Array.from(win.crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('-'))}`;
  let disposed = false;
  const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
  const active = () => { if (disposed) fail("STALE_ELEMENT_REFERENCE", "Annotation session has ended"); picker.assertActive(); };
  const context = () => ({ revision: options.revision?.() ?? 0, ref: options.ref ?? (() => "") });
  const point = (p: BrowserAnnotationDragRequest["start"]) => {
    if (!p || ![p.x, p.y, p.frameWidth, p.frameHeight].every(Number.isFinite) || p.frameWidth <= 0 || p.frameHeight <= 0 || p.x < 0 || p.y < 0 || p.x > p.frameWidth || p.y > p.frameHeight) fail("INVALID_ARGUMENT", "Invalid selection point");
    if (Math.abs(p.frameWidth / p.frameHeight - win.innerWidth / win.innerHeight) > 0.02) fail("INVALID_ARGUMENT", "Viewport changed; select again");
    return { x: p.x * win.innerWidth / p.frameWidth, y: p.y * win.innerHeight / p.frameHeight };
  };
  const drag = (request: BrowserAnnotationDragRequest) => {
    active();
    if (!request?.start || !request.end || request.start.frameWidth !== request.end.frameWidth || request.start.frameHeight !== request.end.frameHeight) fail("INVALID_ARGUMENT", "Selection viewport changed");
    return { start: point(request.start), end: point(request.end) };
  };
  const pickRegion = (request: BrowserAnnotationDragRequest): BrowserAnnotationPick => {
    const { start, end } = drag(request);
    const x = Math.min(start.x, end.x), y = Math.min(start.y, end.y), width = Math.abs(start.x - end.x), height = Math.abs(start.y - end.y);
    if (width < 2 || height < 2) fail("INVALID_ARGUMENT", "Select a larger region");
    return {
      anchor: { kind: "region", url: document.URL, title: document.title.slice(0, 200), revision: context().revision, ref: "", selector: null, elementPath: "region", tag: "", role: null, name: null, text: null, nearbyText: null, childCount: 0, sensitive: false, rect: { x: x + win.scrollX, y: y + win.scrollY, width, height }, isFixed: false, source: null, frame: "main", framePath: [], documentGeneration: picker.generation(document) },
      depth: 0, maxDepth: 0,
      viewport: { left: x / win.innerWidth, right: (x + width) / win.innerWidth, top: y / win.innerHeight, bottom: (y + height) / win.innerHeight },
    };
  };
  const excluded = (element: Element | null): boolean => {
    for (let el = element; el; el = el.parentElement ?? (el.getRootNode() as ShadowRoot).host ?? null) {
      if (el.matches("input,textarea,select,option,[contenteditable],script,style,noscript,[hidden],#opencraft-annotation-host")) return true;
      const style = el.ownerDocument.defaultView!.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return true;
    }
    return false;
  };
  type CaretDocument = Document & {
    caretPositionFromPoint?: (x: number, y: number, options?: { shadowRoots: ShadowRoot[] }) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const caret = (location: ReturnType<AnnotationPicker["locate"]>) => {
    if (excluded(location.element)) fail("POLICY_BLOCKED", "Form controls and editable content cannot be selected");
    const doc = location.document as CaretDocument;
    const roots: ShadowRoot[] = [];
    for (let root = location.element.getRootNode(); "host" in root; root = (root as ShadowRoot).host.getRootNode()) roots.push(root as ShadowRoot);
    const position = doc.caretPositionFromPoint?.(location.x, location.y, { shadowRoots: roots });
    const range = position ? null : doc.caretRangeFromPoint?.(location.x, location.y);
    const node = position?.offsetNode ?? range?.startContainer, offset = position?.offset ?? range?.startOffset;
    if (!node || offset === undefined || node.nodeType !== 3 || excluded(node.parentElement)) return fail("NO_ELEMENT", "No selectable text at this point");
    return { node, offset };
  };
  const pickText = (request: BrowserAnnotationDragRequest): BrowserAnnotationPick => {
    drag(request);
    const startLocation = picker.locate(request.start), endLocation = picker.locate(request.end);
    if (startLocation.document !== endLocation.document) fail("UNSUPPORTED_FRAME", "Select text within one document");
    let start = caret(startLocation), end = caret(endLocation);
    if (start.node.getRootNode() !== end.node.getRootNode()) fail("UNSUPPORTED_FRAME", "Select text within one shadow root");
    const doc = startLocation.document;
    const first = doc.createRange(), last = doc.createRange();
    first.setStart(start.node, start.offset); first.collapse(true);
    last.setStart(end.node, end.offset); last.collapse(true);
    if (first.compareBoundaryPoints(0, last) > 0) [start, end] = [end, start];
    const range = doc.createRange(); range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
    const common = range.commonAncestorContainer;
    const owner = common.nodeType === 1 ? common as Element : common.parentElement;
    if (!owner || excluded(owner)) fail("POLICY_BLOCKED", "This text is not available for annotation");
    // Walk only the selected subtree, with a hard bound; never persist a live Range.
    const walker = doc.createTreeWalker(common, 1 | 4);
    let count = 0, size = 0;
    for (let node: Node | null = common; node; node = walker.nextNode()) {
      if (++count > 10000) fail("INVALID_ARGUMENT", "Text selection is too large");
      if (!range.intersectsNode(node)) continue;
      const el = node.nodeType === 1 ? node as Element : node.parentElement;
      if (excluded(el)) fail("POLICY_BLOCKED", "Selection includes hidden or editable content");
      if (node.nodeType === 3) {
        const from = node === start.node ? start.offset : 0;
        const to = node === end.node ? end.offset : node.textContent?.length ?? 0;
        size += Math.max(0, to - from);
        if (size > 2000) fail("INVALID_ARGUMENT", "Select at most 2000 characters");
      }
    }
    const text = range.toString();
    if (!text || text.length > 2000) fail("INVALID_ARGUMENT", "Select between 1 and 2000 characters");
    const pick = picker.describe(owner!, context());
    if (pick.anchor.sensitive) fail("POLICY_BLOCKED", "Selection includes sensitive content");
    const box = range.getBoundingClientRect(), elementBox = owner!.getBoundingClientRect();
    const x = pick.anchor.rect.x + box.x - elementBox.x, y = pick.anchor.rect.y + box.y - elementBox.y;
    const lineRects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0).filter((r, i, all) => !all.slice(0, i).some(q => Math.abs(q.x-r.x)<.5 && Math.abs(q.y-r.y)<.5 && Math.abs(q.width-r.width)<.5 && Math.abs(q.height-r.height)<.5));
    const path = (node: Node): number[] => {
      const result: number[] = [];
      while (node.parentNode) { result.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes, node)); node = node.parentNode; }
      return result;
    };
    return { ...pick, anchor: { ...pick.anchor, kind: "text", ref: "", selectedText: text, text: text.slice(0, 80), nearbyText: null,
      selectionRects: lineRects.length <= 64 ? lineRects.map(r => ({ x: x + r.x - box.x, y: y + r.y - box.y, width: r.width, height: r.height })) : undefined,
      textLocator: { startPath: path(start.node), startOffset: start.offset, endPath: path(end.node), endOffset: end.offset },
      rect: { x, y, width: box.width, height: box.height } },
      viewport: { left: Math.max(0, (x - (pick.anchor.isFixed ? 0 : win.scrollX)) / win.innerWidth), right: Math.min(1, (x + box.width - (pick.anchor.isFixed ? 0 : win.scrollX)) / win.innerWidth), top: Math.max(0, (y - (pick.anchor.isFixed ? 0 : win.scrollY)) / win.innerHeight), bottom: Math.min(1, (y + box.height - (pick.anchor.isFixed ? 0 : win.scrollY)) / win.innerHeight) } };
  };
  const resolve = (anchor: BrowserAnnotationAnchor) => {
    active();
    if (!anchor || anchor.kind === "region") fail("INVALID_ARGUMENT", "This operation requires an element or text target");
    const element = picker.resolve(anchor);
    if (excluded(element) || picker.describe(element, context()).anchor.sensitive) fail("POLICY_BLOCKED", "This target is not available for annotation");
    return element as HTMLElement;
  };
  const readStyles = (anchor: BrowserAnnotationAnchor): Readonly<Record<string, string>> => {
    const element = resolve(anchor), style = element.ownerDocument.defaultView!.getComputedStyle(element);
    return Object.fromEntries(properties.map((property) => [property, style.getPropertyValue(property).slice(0, 200)]));
  };
  type Write = { element: HTMLElement; token: string; style: HTMLStyleElement; inlineBefore: string | null; text?: { node: Text; before: string; after: string }; anchor: BrowserAnnotationAnchor };
  let writes: Write[] = [];
  const clearPreview = () => {
    for (const write of writes) {
      write.style.remove();
      if (write.element.getAttribute(attribute) === write.token) write.element.removeAttribute(attribute);
      if (write.text && write.text.node.parentNode === write.element && write.text.node.data === write.text.after) write.text.node.data = write.text.before;
    }
    writes = [];
  };
  const preview = (request: BrowserAnnotationPreviewRequest) => {
    active();
    if (!options.authorizePreview?.()) { clearPreview(); fail("POLICY_BLOCKED", "Page preview is not authorized"); }
    if (!request || !Array.isArray(request.changes) || request.changes.length > 32) fail("INVALID_ARGUMENT", "At most 32 preview changes are allowed");
    // Never overwrite a site's intervening text/inline-style or a detached target.
    for (const write of writes) {
      let valid = false;
      try { valid = picker.resolve(write.anchor) === write.element; } catch { /* stale */ }
      if (!valid || write.element.getAttribute(attribute) !== write.token || write.element.getAttribute("style") !== write.inlineBefore || write.text && (write.text.node.parentNode !== write.element || write.text.node.data !== write.text.after)) {
        clearPreview(); fail("PREVIEW_CONFLICT", "The page changed during preview; select again");
      }
    }
    if (request.original) { clearPreview(); return; }
    // Validate complete batch before changing the previous preview.
    const changes = request.changes.map((change) => {
      const element = resolve(change.anchor);
      if (change.text !== undefined) {
        if (typeof change.text !== "string" || change.text.length > 2000 || element.childNodes.length !== 1 || element.firstChild?.nodeType !== 3) fail("INVALID_ARGUMENT", "Text preview supports only a single plain text node");
        const existing = writes.find((write) => write.element === element)?.text;
        const before = existing?.before ?? element.firstChild!.textContent!;
        if (change.anchor.kind === "text" && change.anchor.selectedText !== before) fail("PREVIEW_CONFLICT", "Select the entire simple text target to preview replacement");
        if (change.anchor.kind === "element" && before.replace(/\s+/g, " ").trim() !== change.anchor.text) fail("PREVIEW_CONFLICT", "Text changed or was truncated; select again");
      }
      if (change.property !== undefined) {
        if (!properties.includes(change.property) || typeof change.value !== "string" || change.value.length > 200 || /[;{}]|url\s*\(|var\s*\(/i.test(change.value)) fail("INVALID_ARGUMENT", "Unsupported preview style");
        const test = element.ownerDocument.createElement("span").style;
        test.setProperty(change.property, change.value!);
        if (!test.getPropertyValue(change.property)) fail("INVALID_ARGUMENT", "Invalid CSS value");
        if (element.style.getPropertyPriority(change.property) === "important") fail("PREVIEW_NOT_APPLIED", "An inline important declaration prevents this preview");
      }
      if (change.property === undefined && change.text === undefined) fail("INVALID_ARGUMENT", "A style or text change is required");
      return { ...change, element };
    });
    clearPreview();
    try {
      for (const change of changes) {
        let write = writes.find((entry) => entry.element === change.element);
        if (!write) {
          const style = change.element.ownerDocument.createElement("style"), token = String(writes.length);
          write = { element: change.element, token, style, inlineBefore: change.element.getAttribute("style"), anchor: change.anchor };
          writes.push(write); change.element.setAttribute(attribute, token);
          const root = change.element.getRootNode();
          (root.nodeType === 9 ? (root as Document).head ?? (root as Document).documentElement : root).appendChild(style);
        }
        if (change.property !== undefined) {
          const before = change.element.ownerDocument.defaultView!.getComputedStyle(change.element).getPropertyValue(change.property);
          write.style.textContent += `[${attribute}="${write.token}"] { ${change.property}: ${change.value} !important; }\n`;
          if (!write.style.sheet || write.style.sheet.cssRules.length === 0) fail("PREVIEW_NOT_APPLIED", "The page blocked preview styles");
          const after = change.element.ownerDocument.defaultView!.getComputedStyle(change.element).getPropertyValue(change.property);
          const normalized = change.element.ownerDocument.createElement("span").style;
          normalized.setProperty(change.property, change.value!);
          if (after === before && after !== normalized.getPropertyValue(change.property)) fail("PREVIEW_NOT_APPLIED", "The requested style could not be confirmed on this page");
        }
        if (change.text !== undefined) {
          const node = change.element.firstChild as Text;
          write.text ??= { node, before: node.data, after: change.text };
          write.text.after = change.text; node.data = change.text;
        }
      }
    } catch (error) { clearPreview(); throw error; }
  };
  return { pickRegion, pickText, readStyles, preview, clearPreview, dispose: () => { clearPreview(); disposed = true; } };
}
