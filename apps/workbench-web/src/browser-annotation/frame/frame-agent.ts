import type { createAnnotationOverlay } from "@opencraft/browser-preview-bridge/annotation-overlay";
import type { AnnotationPicker } from "@opencraft/browser-preview-bridge";
import type { createAnnotationSelectionRuntime } from "@opencraft/browser-preview-bridge";

export const FRAME_CHANNEL = "opencraft-annotation";

export interface FrameAgentConfig {
  readonly token: string;
  readonly sensitivePattern: string;
  readonly previewAllowed?: boolean;
  /**
   * "parent": sandboxed iframe, postMessage to the embedding app.
   * "console": Electron <webview> guest. Outgoing messages are console lines
   * the host reads from console-message; incoming ones arrive through a
   * receiver the host calls with executeJavaScript.
   */
  readonly transport: { readonly kind: "parent"; readonly parentOrigin: string } | { readonly kind: "console" };
}

/** Console line prefix for the "console" transport. */
export const CONSOLE_PREFIX = "[opencraft-annotation] ";
export const consoleReceiverKey = (token: string) => `opencraft.annotation.${token}`;

/**
 * Runs inside a sandboxed (opaque-origin) HTML preview. Self-contained: it is
 * injected as source text, so it may only reference its parameters and
 * browser globals. It never gets access to the app; the app only receives
 * plain data from it, which it validates and treats as untrusted.
 */
export function annotationFrameAgent(
  win: Window & typeof globalThis,
  createPicker: (win: Window & typeof globalThis, isSensitive: (element: Element) => boolean) => AnnotationPicker,
  config: FrameAgentConfig,
  createOverlay: typeof createAnnotationOverlay,
  createSelection: typeof createAnnotationSelectionRuntime,
): void {
  const CHANNEL = "opencraft-annotation";
  const pattern = new RegExp(config.sensitivePattern, "iu");
  const isSensitive = (element: Element) => {
    const type = (element.getAttribute("type") ?? "").trim().toLowerCase();
    if (type === "password" || type === "hidden") return true;
    return ["name", "id", "placeholder", "aria-label", "autocomplete"].some((name) => pattern.test(element.getAttribute(name) ?? ""));
  };
  const picker = createPicker(win, isSensitive);
  const transport = config.transport;
  const post = (message: Record<string, unknown>) => {
    const data = { channel: CHANNEL, token: config.token, ...message };
    if (transport.kind === "parent") win.parent.postMessage(data, transport.parentOrigin);
    else win.console.debug("[opencraft-annotation] " + JSON.stringify(data));
  };
  const installed = Symbol.for("opencraft.annotation.agent");
  const registry = win as unknown as Record<symbol, unknown>;
  const previous = registry[installed];
  if (typeof previous === "function") previous();
  const events = new win.AbortController();
  const capture = { capture: true, signal: events.signal };
  let active = false;
  const ref = () => "";
  const selection = createSelection(win.document, { picker, revision: () => 0, ref, authorizePreview: () => config.previewAllowed === true });

  const overlay = createOverlay(win);
  const draw = overlay.draw;

  const point = (event: PointerEvent) => ({ x: event.clientX, y: event.clientY, frameWidth: win.innerWidth, frameHeight: win.innerHeight });
  let mode = "element";
  const rootStyle = win.document.documentElement.style;
  const originalCursor = rootStyle.cursor, originalTouchAction = rootStyle.touchAction;
  let down: { id: number; x: number; y: number; type: string; width: number; height: number; scrollX: number; scrollY: number; target: Element | null } | null = null, hoverFrame = 0;
  const selecting = () => active && (mode === "region" || mode === "text");
  const block = (event: Event) => { if (active && mode !== "browse") { event.preventDefault(); event.stopImmediatePropagation(); } };
  const cancel = () => { const previous = down; down = null; if (previous) { try { previous.target?.releasePointerCapture(previous.id); } catch {} } };
  const appearance = () => { rootStyle.cursor = active && mode !== "browse" ? "crosshair" : originalCursor; rootStyle.touchAction = selecting() ? "none" : originalTouchAction; };
  win.addEventListener("pointerdown", (event) => {
    if (!active || mode === "browse" || !event.isPrimary || event.button > 0) return;
    cancel();
    down = { id: event.pointerId, x: event.clientX, y: event.clientY, type: event.pointerType, width: win.innerWidth, height: win.innerHeight, scrollX: win.scrollX, scrollY: win.scrollY, target: event.target instanceof win.Element ? event.target : null };
    if (selecting()) { try { down.target?.setPointerCapture(event.pointerId); } catch {} }
    if (selecting() || event.pointerType === "mouse") block(event);
  }, capture);
  win.addEventListener("pointermove", (event) => {
    if (!active || mode === "browse") return;
    if (selecting()) { block(event); return; }
    if (down && down.id === event.pointerId && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 8) cancel();
    if (event.pointerType !== "mouse" || hoverFrame) return;
    hoverFrame = win.requestAnimationFrame(() => { hoverFrame = 0; if (active) post({ type: "hover", point: point(event) }); });
  }, capture);
  win.addEventListener("pointerup", (event) => {
    if (!active || !down || down.id !== event.pointerId) return;
    const start = down; cancel();
    block(event);
    if (start.width !== win.innerWidth || start.height !== win.innerHeight || start.scrollX !== win.scrollX || start.scrollY !== win.scrollY || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY) || event.clientX < 0 || event.clientY < 0 || event.clientX > win.innerWidth || event.clientY > win.innerHeight) return;
    if (selecting()) post({ type: "drag", start: { x: start.x, y: start.y, frameWidth: start.width, frameHeight: start.height }, end: point(event) });
    else if (Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 8) post({ type: "tap", point: point(event), pointer: start.type });
  }, capture);
  win.addEventListener("pointercancel", cancel, capture);
  win.addEventListener("lostpointercapture", cancel, capture);
  win.addEventListener("resize", cancel, capture);
  win.addEventListener("scroll", cancel, capture);
  win.addEventListener("touchmove", event => { if (selecting()) block(event); }, { ...capture, passive: false });
  for (const name of ["click", "dblclick", "auxclick", "contextmenu", "mousedown", "mouseup", "submit"]) win.addEventListener(name, block, capture);

  const dispose = () => {
    active = false; cancel(); events.abort();
    win.cancelAnimationFrame(hoverFrame);
    overlay.dispose(); selection.dispose(); picker.dispose();
    appearance();
    delete registry[Symbol.for("opencraft.annotation." + config.token)];
    if (registry[installed] === dispose) delete registry[installed];
  };
  registry[installed] = dispose;
  const receive = (data: Record<string, unknown> | null) => {
    if (!data || data.channel !== CHANNEL || data.token !== config.token) return;
    if (data.type === "dispose") { dispose(); return; }
    if (data.type === "start") { cancel(); active = true; mode = ["region", "text", "browse"].includes(String(data.mode)) ? String(data.mode) : "element"; appearance(); return; }
    if (data.type === "stop") { active = false; cancel(); appearance(); return; }
    if (data.type === "marks") { draw(data.boxes, data.color); return; }
    if (data.type === "reveal" && typeof data.fraction === "number" && Number.isFinite(data.fraction)) {
      win.scrollBy({ top: Math.max(-1, Math.min(1, data.fraction)) * win.innerHeight, behavior: "instant" as ScrollBehavior });
      return;
    }
    if (["hit", "pick", "region", "text", "styles", "preview", "clearPreview"].includes(String(data.type))) {
      try {
        let result: unknown;
        if (data.type === "hit") result = overlay.hit(data.point as Parameters<typeof overlay.hit>[0]);
        else if (data.type === "pick") result = picker.pick({ point: data.point, depth: data.depth, selector: data.selector }, { revision: 0, ref });
        else if (data.type === "region") result = selection.pickRegion(data as unknown as Parameters<typeof selection.pickRegion>[0]);
        else if (data.type === "text") result = selection.pickText(data as unknown as Parameters<typeof selection.pickText>[0]);
        else if (data.type === "styles") result = selection.readStyles(data.anchor as Parameters<typeof selection.readStyles>[0]);
        else if (data.type === "preview") result = selection.preview(data.input as Parameters<typeof selection.preview>[0]);
        else result = selection.clearPreview();
        const anchor = (result as { anchor?: Parameters<typeof picker.resolve>[0] } | undefined)?.anchor;
        if (anchor?.bindingKey) overlay.bind(anchor.bindingKey, picker.resolve(anchor));
        if (anchor?.documentGeneration && anchor.kind !== "element") overlay.bindGeneration(anchor.documentGeneration, anchor.kind === "region" ? win.document : picker.resolve(anchor).ownerDocument);
        post({ type: "reply", id: data.id, ok: true, result });
      } catch (error) {
        post({ type: "reply", id: data.id, ok: false, error: { code: (error as { code?: string }).code ?? "PICK_FAILED", message: (error as Error).message } });
      }
    }
  };
  if (transport.kind === "parent") {
    win.addEventListener("message", (event) => {
      if (event.source !== win.parent || event.origin !== transport.parentOrigin) return;
      receive(event.data as Record<string, unknown> | null);
    }, { signal: events.signal });
  } else {
    (win as unknown as Record<symbol, unknown>)[Symbol.for("opencraft.annotation." + config.token)] = receive;
  }
  post({ type: "ready" });
}
