import {
  BrowserAutomationError,
  browserControlAttributesAreSensitive,
  type BrowserAnnotationAnchor,
  type BrowserAnnotationFrameSegment,
  type BrowserAnnotationPick,
  type BrowserAnnotationPoint,
} from "@opencraft/browser-core";

export const ANNOTATION_OVERLAY_HOST_ID = "opencraft-annotation-host";
export interface AnnotationPickContext {
  readonly revision: number;
  readonly ref: (element: Element) => string;
}
export interface AnnotationLocation {
  readonly element: Element;
  readonly document: Document;
  readonly x: number;
  readonly y: number;
}
export interface AnnotationPicker {
  pick(params: unknown, context: AnnotationPickContext): BrowserAnnotationPick;
  describe(element: Element, context: AnnotationPickContext): BrowserAnnotationPick;
  locate(point: BrowserAnnotationPoint): AnnotationLocation;
  resolve(anchor: BrowserAnnotationAnchor): Element;
  generation(document: Document): string;
  assertActive(): void;
  dispose(): void;
  uniqueSelector(element: Element): string | null;
  candidates(hit: Element): Element[];
}

/** No module-scope runtime dependencies: injectable using toString(). */
export function createAnnotationPicker(
  win: Window & typeof globalThis,
  isSensitive: (element: Element) => boolean,
): AnnotationPicker {
  const document = win.document,
    root = document.documentElement;
  let disposed = false,
    sequence = 0;
  const session =
    win.crypto.randomUUID?.() ??
    Array.from(win.crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16)).join("-");
  const generations = new WeakMap<Document, { root: Element; key: string }>();
  const bindings = new WeakMap<Element, string>();
  const elements = new Map<string, { element: WeakRef<Element>; generation: string }>();
  const HOST = "opencraft-annotation-host";
  const fail = (code: string, message: string): never => {
    throw Object.assign(new Error(message), { code });
  };
  const assertActive = () => {
    if (disposed || win.document !== document || document.documentElement !== root)
      fail("STALE_ELEMENT_REFERENCE", "The document was replaced; select again");
  };
  const generation = (doc: Document) => {
    let entry = generations.get(doc);
    if (!entry || entry.root !== doc.documentElement) {
      entry = { root: doc.documentElement, key: `${session}:d${++sequence}` };
      generations.set(doc, entry);
    }
    return entry.key;
  };
  const parent = (element: Element): Element | null =>
    element.parentElement ?? (element.getRootNode() as ShadowRoot).host ?? null;
  const collapse = (value: string | null | undefined, limit = 80): string | null => {
    const text = value?.replace(/\s+/g, " ").trim();
    return text ? (text.length > limit ? `${text.slice(0, limit - 1)}…` : text) : null;
  };
  const escape = (value: string) =>
    win.CSS?.escape ? win.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  const uniqueSelector = (element: Element): string | null => {
    const scope = element.getRootNode() as Document | ShadowRoot;
    const parts: string[] = [];
    for (let current: Element | null = element; current && parts.length < 8; current = current.parentElement) {
      let part = current.tagName.toLowerCase();
      if (current.id) part += `#${escape(current.id)}`;
      else {
        part += [...current.classList]
          .filter((name) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name))
          .slice(0, 2)
          .map((name) => `.${name}`)
          .join("");
        if (current.parentElement) {
          const peers = [...current.parentElement.children].filter((el) => el.tagName === current!.tagName);
          if (peers.length > 1) part += `:nth-of-type(${peers.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      const selector = parts.join(" > ");
      if (selector.length > 500) return null;
      try {
        const matches = scope.querySelectorAll(selector);
        if (matches.length === 1 && matches[0] === element) {
          if ("host" in scope) {
            const host = uniqueSelector(scope.host);
            return host && host.length + selector.length + 5 <= 500 ? `${host} >>> ${selector}` : null;
          }
          return selector;
        }
      } catch {
        return null;
      }
    }
    return null;
  };
  const frameInfo = (doc: Document) => {
    let x = 0,
      y = 0,
      current = doc;
    const path: BrowserAnnotationFrameSegment[] = [];
    for (let depth = 0; current !== document; depth++) {
      if (depth >= 12) fail("UNSUPPORTED_FRAME", "Frame nesting is too deep");
      const childWindow = current.defaultView;
      const frame = childWindow?.frameElement as HTMLIFrameElement | null;
      if (!frame || !frame.isConnected || frame.contentDocument !== current)
        fail("STALE_ELEMENT_REFERENCE", "The frame document changed");
      // Perspective, rotation, scaling and CSS zoom need a host geometry contract.
      for (let ancestor: Element | null = frame; ancestor; ancestor = parent(ancestor)) {
        const style = ancestor.ownerDocument.defaultView!.getComputedStyle(ancestor);
        if (style.transform !== "none" || (style.zoom && style.zoom !== "1" && style.zoom !== "normal"))
          fail("UNSUPPORTED_FRAME", "Transformed frames cannot be mapped reliably");
      }
      const box = frame!.getBoundingClientRect();
      x += box.x + frame!.clientLeft;
      y += box.y + frame!.clientTop;
      path.unshift({ selector: uniqueSelector(frame!), documentGeneration: generation(current) });
      current = frame!.ownerDocument;
    }
    return { x, y, path };
  };
  const locate = (point: BrowserAnnotationPoint): AnnotationLocation => {
    assertActive();
    if (
      !point ||
      ![point.x, point.y, point.frameWidth, point.frameHeight].every(Number.isFinite) ||
      point.frameWidth <= 0 ||
      point.frameHeight <= 0
    )
      fail("INVALID_ARGUMENT", "point with frame size is required");
    if (Math.abs(point.frameWidth / point.frameHeight - win.innerWidth / win.innerHeight) > 0.02)
      fail("INVALID_ARGUMENT", "Viewport changed; select again");
    let x = (point.x * win.innerWidth) / point.frameWidth,
      y = (point.y * win.innerHeight) / point.frameHeight;
    if (x < 0 || y < 0 || x >= win.innerWidth || y >= win.innerHeight)
      fail("INVALID_ARGUMENT", "point is outside the page");
    let doc = document;
    for (let depth = 0; depth < 24; depth++) {
      let hit = (doc.elementsFromPoint(x, y) ?? []).find((el) => !el.closest(`#${HOST}`));
      if (!hit) return fail("NO_ELEMENT", "Nothing to annotate at this point");
      for (let i = 0; hit.shadowRoot && i < 12; i++) {
        const deeper = hit.shadowRoot.elementFromPoint?.(x, y);
        if (!deeper || deeper === hit) break;
        hit = deeper;
      }
      if (hit.tagName !== "IFRAME" && hit.tagName !== "FRAME") return { element: hit, document: doc, x, y };
      const frame = hit as HTMLIFrameElement;
      let child: Document | null = null;
      try {
        child = frame.contentDocument;
      } catch {
        /* cross origin */
      }
      if (!child) return fail("UNSUPPORTED_FRAME", "This embedded document is not accessible");
      frameInfo(child);
      const box = frame.getBoundingClientRect();
      x -= box.x + frame.clientLeft;
      y -= box.y + frame.clientTop;
      if (x < 0 || y < 0 || x >= child.defaultView!.innerWidth || y >= child.defaultView!.innerHeight)
        fail("UNSUPPORTED_FRAME", "Point is on a frame border");
      doc = child;
    }
    return fail("UNSUPPORTED_FRAME", "Frame nesting is too deep");
  };
  const candidates = (hit: Element) => {
    const chain: Element[] = [];
    const first =
      hit.closest(
        "a[href],button,input,textarea,select,summary,label,img,svg,video,canvas,[role],[tabindex],[contenteditable],h1,h2,h3,h4,h5,h6,p,li,td,th",
      ) ?? hit;
    for (let current: Element | null = first; current && chain.length < 12; current = parent(current)) {
      if (/^(BODY|HTML)$/.test(current.tagName)) break;
      const rect = current.getBoundingClientRect(),
        previous = chain.at(-1)?.getBoundingClientRect();
      if (
        previous &&
        rect.width === previous.width &&
        rect.height === previous.height &&
        rect.x === previous.x &&
        rect.y === previous.y
      )
        continue;
      chain.push(current);
    }
    return chain;
  };
  const sensitiveTree = (element: Element): boolean =>
    isSensitive(element) ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) ||
    !!element.querySelector("input,textarea,select,[contenteditable]");
  const semanticMetadata = (element: Element) => {
    const raw = element.getAttribute("data-oc-annotation-metadata");
    if (!raw || raw.length > 4096) return undefined;
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      const entries = Object.entries(value);
      if (
        entries.length > 16 ||
        entries.some(
          ([key, v]) =>
            key.length > 80 ||
            ["__proto__", "constructor", "prototype"].includes(key) ||
            !(
              v === null ||
              typeof v === "boolean" ||
              (typeof v === "number" && Number.isFinite(v)) ||
              (typeof v === "string" && v.length <= 256)
            ),
        )
      )
        return undefined;
      return Object.fromEntries(entries) as Readonly<Record<string, string | number | boolean | null>>;
    } catch {
      return undefined;
    }
  };
  const describe = (element: Element, context: AnnotationPickContext): BrowserAnnotationPick => {
    assertActive();
    if (!element.isConnected || element.ownerDocument.defaultView?.document !== element.ownerDocument)
      fail("STALE_ELEMENT_REFERENCE", "Target detached");
    const doc = element.ownerDocument,
      info = frameInfo(doc),
      docGeneration = generation(doc);
    let bindingKey = bindings.get(element);
    if (!bindingKey || !elements.has(bindingKey)) {
      bindingKey = `${session}:e${++sequence}`;
      bindings.set(element, bindingKey);
    }
    elements.set(bindingKey, { element: new WeakRef(element), generation: docGeneration });
    if (elements.size > 2048) elements.delete(elements.keys().next().value!);
    let sensitive = sensitiveTree(element),
      fixed = false;
    const tags: string[] = [];
    for (let current: Element | null = element; current; current = parent(current)) {
      sensitive ||= isSensitive(current) || current.hasAttribute("contenteditable");
      fixed ||= /^(fixed|sticky)$/.test(doc.defaultView!.getComputedStyle(current).position);
      if (tags.length < 4 && !/^(HTML|BODY)$/.test(current.tagName)) tags.unshift(current.tagName.toLowerCase());
    }
    // Child targets use top document coordinates; top scroll always applies.
    if (doc !== document) fixed = false;
    const box = element.getBoundingClientRect(),
      x = box.x + info.x,
      y = box.y + info.y;
    const nearbySensitive = sensitive || (!!element.parentElement && sensitiveTree(element.parentElement));
    return {
      anchor: {
        kind: "element",
        bindingKey,
        documentGeneration: docGeneration,
        url: doc.URL,
        title: collapse(doc.title, 200) ?? "",
        revision: context.revision,
        // Host's main-document ref table cannot claim child-frame tool support.
        ref: doc === document && element.getRootNode() === document ? context.ref(element) : "",
        selector: uniqueSelector(element),
        elementPath: tags.join(" > "),
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        name: sensitive
          ? null
          : collapse(
              element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.getAttribute("alt"),
            ),
        text: sensitive
          ? null
          : (collapse(
              [...element.childNodes]
                .filter((node) => node.nodeType === 3)
                .map((node) => node.textContent ?? "")
                .join(" "),
            ) ?? collapse((element as HTMLElement).innerText ?? element.textContent)),
        nearbyText: nearbySensitive
          ? null
          : collapse((element.parentElement as HTMLElement | null)?.innerText ?? element.parentElement?.textContent),
        childCount: element.children.length,
        sensitive,
        rect: {
          x: x + (fixed ? 0 : win.scrollX),
          y: y + (fixed ? 0 : win.scrollY),
          width: box.width,
          height: box.height,
        },
        isFixed: fixed,
        source: element.closest("[data-oc-source]")?.getAttribute("data-oc-source")?.slice(0, 300) ?? null,
        frame: doc === document ? "main" : "child",
        framePath: info.path,
        ...(!sensitive && semanticMetadata(element) ? { elementMetadata: semanticMetadata(element) } : {}),
        ...(!sensitive && element.getAttribute("data-oc-annotation-name")
          ? { elementName: element.getAttribute("data-oc-annotation-name")!.slice(0, 120) }
          : {}),
      },
      depth: 0,
      maxDepth: Math.max(0, candidates(element).length - 1),
      viewport: {
        left: Math.max(0, x / win.innerWidth),
        right: Math.min(1, (x + box.width) / win.innerWidth),
        top: Math.max(0, y / win.innerHeight),
        bottom: Math.min(1, (y + box.height) / win.innerHeight),
      },
    };
  };
  const resolve = (anchor: BrowserAnnotationAnchor): Element => {
    assertActive();
    const entry = anchor?.bindingKey ? elements.get(anchor.bindingKey) : undefined;
    const element = entry?.element.deref();
    if (
      !element ||
      !element.isConnected ||
      entry!.generation !== generation(element.ownerDocument) ||
      anchor.documentGeneration !== entry!.generation
    )
      return fail("STALE_ELEMENT_REFERENCE", "Target identity is no longer available");
    frameInfo(element.ownerDocument);
    return element;
  };
  const pick = (params: unknown, context: AnnotationPickContext): BrowserAnnotationPick => {
    const request = params as { point: BrowserAnnotationPoint; depth?: number; selector?: string };
    const location = locate(request?.point);
    let hit = location.element;
    if (request.selector !== undefined) {
      if (typeof request.selector !== "string" || request.selector.length > 500)
        fail("INVALID_ARGUMENT", "Invalid selector");
      let scope: Document | ShadowRoot = location.document;
      const parts = request.selector.split(" >>> ");
      for (let i = 0; i < parts.length; i++) {
        let matches: NodeListOf<Element>;
        try {
          matches = scope.querySelectorAll(parts[i]!);
        } catch {
          return fail("INVALID_ARGUMENT", "Invalid selector");
        }
        if (matches.length !== 1) fail("NO_ELEMENT", "The selected target changed; select it again");
        hit = matches[0]!;
        if (i < parts.length - 1) {
          if (!hit.shadowRoot) fail("NO_ELEMENT", "Shadow root is unavailable");
          scope = hit.shadowRoot!;
        }
      }
    }
    if (/^(HTML|BODY)$/.test(hit.tagName)) fail("NO_ELEMENT", "Nothing to annotate at this point");
    const chain = candidates(hit),
      maxDepth = Math.max(0, chain.length - 1);
    const depth = Math.min(maxDepth, Math.max(0, Math.floor(Number.isFinite(request.depth) ? request.depth! : 0)));
    return { ...describe(chain[depth] ?? hit, context), depth, maxDepth };
  };
  return {
    pick,
    describe,
    locate,
    resolve,
    generation,
    assertActive,
    uniqueSelector,
    candidates,
    dispose: () => {
      disposed = true;
      elements.clear();
    },
  };
}

export function annotationElementIsSensitive(element: Element): boolean {
  return browserControlAttributesAreSensitive({
    type: element.getAttribute("type"),
    name: element.getAttribute("name"),
    id: element.getAttribute("id"),
    placeholder: element.getAttribute("placeholder"),
    ariaLabel: element.getAttribute("aria-label"),
    autocomplete: element.getAttribute("autocomplete"),
  });
}
export interface AnnotationPickerContext {
  readonly windowValue: Window & typeof globalThis;
  readonly revision: () => number;
  readonly ref: (element: Element) => string;
}
const documentPickers = new WeakMap<Document, AnnotationPicker>();
export function pickAnnotation(
  params: Readonly<Record<string, unknown>>,
  context: AnnotationPickerContext,
): BrowserAnnotationPick {
  try {
    let picker = documentPickers.get(context.windowValue.document);
    if (!picker) {
      picker = createAnnotationPicker(context.windowValue, annotationElementIsSensitive);
      documentPickers.set(context.windowValue.document, picker);
    }
    return picker.pick(params, { revision: context.revision(), ref: context.ref });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string")
      throw new BrowserAutomationError(code, (error as Error).message, code === "NO_ELEMENT");
    throw error;
  }
}
export function uniqueSelector(element: Element, windowValue: Window & typeof globalThis): string | null {
  return createAnnotationPicker(windowValue, annotationElementIsSensitive).uniqueSelector(element);
}
export function annotationCandidates(hit: Element): Element[] {
  return createAnnotationPicker(
    hit.ownerDocument.defaultView as Window & typeof globalThis,
    annotationElementIsSensitive,
  ).candidates(hit);
}
