import type { BrowserAnnotationAnchor, BrowserAnnotationMark, BrowserAnnotationPick, BrowserAnnotationPointerHandlers, BrowserAnnotator } from "@opencraft/browser-core";
import { BROWSER_ANNOTATION_STYLE_PROPERTIES } from "@opencraft/browser-core";
import { FRAME_CHANNEL } from "./frame-agent";

const str = (value: unknown, limit: number): string | null => typeof value === "string" ? value.slice(0, limit) : null;
const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(-10_000_000, Math.min(10_000_000, Math.round(value))) : 0;
const unit = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const sanitizeMetadata = (value: unknown) => {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of Object.entries(record(value)).slice(0, 20)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,59}$/.test(key) || ["constructor", "prototype"].includes(key)) continue;
    if (typeof entry === "string") result[key] = entry.slice(0, 300);
    else if (entry === null || typeof entry === "boolean" || typeof entry === "number" && Number.isFinite(entry)) result[key] = entry;
  }
  return result;
};
const sanitizeTextLocator = (value: unknown): BrowserAnnotationAnchor["textLocator"] => {
  const locator = record(value);
  const path = (value: unknown): value is number[] => Array.isArray(value) && value.length <= 64 && value.every(index => Number.isSafeInteger(index) && index >= 0 && index <= 100_000);
  if (!path(locator.startPath) || !path(locator.endPath) || !Number.isSafeInteger(locator.startOffset) || !Number.isSafeInteger(locator.endOffset) || Number(locator.startOffset) < 0 || Number(locator.endOffset) < 0) return undefined;
  return { startPath: [...locator.startPath], endPath: [...locator.endPath], startOffset: Math.min(1_000_000, Number(locator.startOffset)), endOffset: Math.min(1_000_000, Number(locator.endOffset)) };
};
export function sanitizeFrameStyles(value: unknown): Readonly<Record<string, string>> {
  const raw = record(value), result: Record<string, string> = {};
  for (const property of BROWSER_ANNOTATION_STYLE_PROPERTIES) {
    const entry = str(raw[property], 300);
    if (entry !== null && !/url\s*\(|[\x00-\x1f]/i.test(entry)) result[property] = entry;
  }
  return result;
}

/** Everything from the frame is page-controlled: rebuild it field by field. */
export interface AnnotatedDocument {
  readonly url: string;
  readonly title: string;
  /** Host-owned identity, including same-URL reloads. */
  readonly generation?: string;
  /** Overrides the page-reported source (file previews); undefined keeps it. */
  readonly source?: string | null;
}

export function sanitizeFramePick(raw: unknown, document: AnnotatedDocument): BrowserAnnotationPick {
  const value = (raw ?? {}) as Record<string, unknown>;
  const a = (value.anchor ?? {}) as Record<string, unknown>;
  const rect = (a.rect ?? {}) as Record<string, unknown>;
  const viewport = (value.viewport ?? {}) as Record<string, unknown>;
  const anchor: BrowserAnnotationAnchor = {
    kind: a.kind === "region" || a.kind === "text" ? a.kind : "element",
    selectedText: a.sensitive === true ? undefined : str(a.selectedText, 2000) ?? undefined,
    documentGeneration: str(a.documentGeneration, 100) ?? undefined,
    elementName: str(a.elementName, 100) ?? undefined,
    elementMetadata: a.sensitive === true ? undefined : sanitizeMetadata(a.elementMetadata),
    selectionRects: Array.isArray(a.selectionRects) && a.sensitive !== true ? a.selectionRects.slice(0, 64).filter(r => r && typeof r === "object").map(r => ({ x: num(r.x), y: num(r.y), width: Math.max(0, num(r.width)), height: Math.max(0, num(r.height)) })) : undefined,
    textLocator: a.sensitive === true ? undefined : sanitizeTextLocator(a.textLocator),
    framePath: Array.isArray(a.framePath) ? a.framePath.slice(0, 16).map(segment => {
      const entry = record(segment);
      return { selector: str(entry.selector, 500), documentGeneration: str(entry.documentGeneration, 100) ?? "", url: str(entry.url, 2048) ?? undefined };
    }) : undefined,
    url: document.url,
    title: document.title,
    revision: 0,
    ref: "",
    bindingKey: str(a.bindingKey, 100) ?? undefined,
    selector: str(a.selector, 500),
    elementPath: str(a.elementPath, 200) ?? "",
    tag: (str(a.tag, 40) ?? "element").toLowerCase(),
    role: str(a.role, 60),
    name: str(a.name, 80),
    text: a.sensitive === true ? null : str(a.text, 80),
    nearbyText: a.sensitive === true ? null : str(a.nearbyText, 80),
    childCount: Math.max(0, Math.min(10_000, num(a.childCount))),
    sensitive: a.sensitive === true,
    rect: { x: num(rect.x), y: num(rect.y), width: Math.max(0, num(rect.width)), height: Math.max(0, num(rect.height)) },
    isFixed: a.isFixed === true,
    source: document.source !== undefined ? document.source : str(a.source, 300),
    frame: a.frame === "child" ? "child" : "main",
  };
  const maxDepth = Math.max(0, Math.min(12, num(value.maxDepth)));
  return { anchor, depth: Math.max(0, Math.min(maxDepth, num(value.depth))), maxDepth, viewport: { ...(typeof viewport.left === "number" && typeof viewport.right === "number" ? { left: unit(viewport.left), right: unit(viewport.right) } : {}), top: unit(viewport.top), bottom: unit(viewport.bottom) } };
}

export interface AgentChannel {
  /** Deliver a message to the in-page agent (it adds channel and token). */
  send(message: Record<string, unknown>): void | Promise<void>;
  /** Messages from the agent, already matched to this channel and token. */
  subscribe(listener: (data: Record<string, unknown>) => void): () => void;
  document(): AnnotatedDocument;
  capture(): Promise<string>;
  readonly captureSupported?: boolean;
  /** Explicit controlled-local-preview host policy; external pages default false. */
  readonly previewAllowed?: boolean;
  subscribeNavigation?(listener: () => void): () => void;
}

/** BrowserAnnotator over an in-page agent. Everything received is untrusted. */
export function createAgentAnnotator(channel: AgentChannel): BrowserAnnotator & { dispose(): void } {
  let id = 0, handlers: BrowserAnnotationPointerHandlers | null = null, marks: { boxes: readonly BrowserAnnotationMark[]; color?: string } = { boxes: [] };
  let disposed = false, generation = 0, ready = false;
  const pending = new Map<number, { document: AnnotatedDocument; generation: number; decode(value: unknown, document: AnnotatedDocument): unknown; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const navigate = () => {
    ++generation; marks = { boxes: [] };
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Preview navigated")); }
    pending.clear();
  };
  const send = (message: Record<string, unknown>) => {
    const expectedGeneration = generation;
    void Promise.resolve().then(() => {
      if (generation !== expectedGeneration || disposed && message.type !== "dispose") return;
      return channel.send(message);
    }).catch((cause) => {
      if (generation !== expectedGeneration) return;
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(cause instanceof Error ? cause : new Error(String(cause))); }
      pending.clear();
    });
  };
  const pointOf = (value: unknown) => {
    const p = (value ?? {}) as Record<string, unknown>;
    if (![p.x, p.y, p.frameWidth, p.frameHeight].every(value => typeof value === "number" && Number.isFinite(value))) return null;
    const point = { x: p.x as number, y: p.y as number, frameWidth: p.frameWidth as number, frameHeight: p.frameHeight as number };
    return point.frameWidth > 0 && point.frameHeight > 0 && point.x >= 0 && point.y >= 0 && point.x <= point.frameWidth && point.y <= point.frameHeight ? point : null;
  };
  const onMessage = (data: Record<string, unknown>) => {
    if (disposed) return;
    if (data.type === "ready") { // srcdoc reloaded: restore state
      if (ready) navigate();
      ready = true;
      if (handlers) send({ type: "start", mode: handlers.mode ?? "element" });
      if (marks.boxes.length) send({ type: "marks", boxes: marks.boxes, color: marks.color });
      return;
    }
    if (data.type === "drag") {
      const start = pointOf(data.start), end = pointOf(data.end);
      if (start && end && handlers && (handlers.mode === "region" || handlers.mode === "text")) handlers.drag?.(start, end);
      return;
    }
    if (data.type === "tap" || data.type === "hover") {
      const point = pointOf(data.point);
      if (!point || !handlers || handlers.mode && handlers.mode !== "element") return;
      if (data.type === "tap") handlers.tap(point, data.pointer === "touch" ? "touch" : data.pointer === "pen" ? "pen" : "mouse");
      else handlers.hover?.(point);
      return;
    }
    if (data.type === "reply" && typeof data.id === "number") {
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id); clearTimeout(request.timer);
      const document = channel.document();
      if (request.generation !== generation || request.document.url !== document.url || request.document.generation !== document.generation) request.reject(new Error("Preview navigated"));
      else if (data.ok === true) {
        try { request.resolve(request.decode(data.result, request.document)); } catch (error) { request.reject(error as Error); }
      }
      else request.reject(new Error(str((data.error as Record<string, unknown> | undefined)?.message, 200) ?? "Annotation failed"));
    }
  };
  const unsubscribe = channel.subscribe(onMessage);
  const unsubscribeNavigation = channel.subscribeNavigation?.(navigate);
  const request = <T>(type: string, input: Record<string, unknown>, decode: (value: unknown, document: AnnotatedDocument) => T): Promise<T> => new Promise((resolve, reject) => {
    if (disposed) { reject(new Error("Preview closed")); return; }
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Preview did not respond")); }, 3000);
    pending.set(requestId, { document: { ...channel.document() }, generation, decode, resolve, reject, timer });
    send({ type, id: requestId, ...input });
  });
  return {
    capabilities: { region: true, text: true, multiSelect: true, styles: true, capture: channel.captureSupported !== false, preview: channel.previewAllowed === true, sameOriginFrames: true, openShadow: true },
    hitMark: point => request("hit", { point }, value => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length <= 240).slice(0, 32) : []),
    pick: input => request("pick", input, sanitizeFramePick),
    pickRegion: input => request("region", { ...input }, sanitizeFramePick),
    pickText: input => request("text", { ...input }, sanitizeFramePick),
    readStyles: anchor => request("styles", { anchor }, sanitizeFrameStyles),
    preview: input => channel.previewAllowed === true ? request("preview", { input }, () => undefined) : Promise.reject(new Error("Preview changes are not allowed on this page")),
    clearPreview: () => request("clearPreview", {}, () => undefined),
    mark: async (boxes, color) => { if (disposed) throw new Error("Preview closed"); marks = { boxes, color }; await channel.send({ type: "marks", boxes, color }); },
    capture: async () => {
      if (disposed) throw new Error("Preview closed");
      const expectedGeneration = generation, before = { ...channel.document() };
      const image = await channel.capture(), after = channel.document();
      if (disposed || generation !== expectedGeneration || before.url !== after.url || before.generation !== after.generation) throw new Error("Preview navigated");
      return image;
    },
    reveal: async (fraction) => { send({ type: "reveal", fraction }); },
    intercept: (next) => {
      handlers = next; send({ type: "start", mode: next.mode ?? "element" });
      return () => { if (handlers === next) { handlers = null; send({ type: "stop" }); } };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true; handlers = null;
      send({ type: "dispose" });
      unsubscribe(); unsubscribeNavigation?.();
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Preview closed")); }
      pending.clear();
    },
  };
}

/**
 * Sandboxed srcdoc iframe (no allow-same-origin). The frame's origin is
 * opaque, so messages are bound to its WindowProxy and a per-mount token.
 */
export function createFrameAnnotator(input: {
  readonly frame: () => HTMLIFrameElement | null;
  readonly token: string;
  readonly document: AnnotatedDocument;
  readonly previewAllowed?: boolean;
}): BrowserAnnotator & { dispose(): void } {
  const target = () => input.frame()?.contentWindow ?? null;
  return createAgentAnnotator({
    send: (message) => target()?.postMessage({ channel: FRAME_CHANNEL, token: input.token, ...message }, "*"),
    subscribe: (listener) => {
      const onMessage = (event: MessageEvent) => {
        const source = target();
        if (source === null || event.source !== source) return;
        const data = event.data as Record<string, unknown> | null;
        if (data && data.channel === FRAME_CHANNEL && data.token === input.token) listener(data);
      };
      window.addEventListener("message", onMessage);
      return () => window.removeEventListener("message", onMessage);
    },
    document: () => input.document,
    captureSupported: false,
    previewAllowed: input.previewAllowed,
    subscribeNavigation: listener => {
      const frame = input.frame(); frame?.addEventListener("load", listener);
      return () => frame?.removeEventListener("load", listener);
    },
    capture: () => Promise.reject(new Error("Sandboxed previews cannot be captured")),
  });
}
