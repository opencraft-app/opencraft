import { mergeTouchMoves } from "@opencraft/remote-interaction/touch";
import type { BrowserAutomationError } from "@opencraft/browser-core";
import type { RemoteBrowserInputPage as Page } from "./remote-browser-surface-host";
import type { BrowserInputFailureKind } from "./web-browser-surface-host";
import { RemoteBrowserIme } from "./remote-browser-ime";
import { RemoteBrowserInputQueue } from "./remote-browser-input-queue";
import { RemoteBrowserEditInput } from "./remote-browser-edit-input";

/** Input resources belong to one Page, not to an individual socket attempt. */
export interface RemoteBrowserInputOwner {
  acceptsInput(p: Page): boolean;
  acceptsPointer(p: Page): boolean;
  call(p: Page, method: string, input?: unknown, expected?: string, document?: string): Promise<any>;
  inputError(p: Page, kind: BrowserInputFailureKind, message: string): void;
  acquireControl(p: Page, kind: "human"): Promise<string>;
  retireMenu(p: Page): void;
  updateKeyboard(p: Page): void;
  queueViewport(p: Page): void;
  syncVisibility(p: Page): void;
  copyCurrent(p: Page): void;
}
/** Loaded before transport admission; all gesture handling stays synchronous. */
export function bindRemoteBrowserInput(host: RemoteBrowserInputOwner, p: Page): () => void {
  const canvas = p.canvas,
    receiver = p.receiver,
    cleanup: (() => void)[] = [];
  const listen = (name: string, handler: (event: any) => void, options?: AddEventListenerOptions) => {
    canvas.addEventListener(name, handler, options);
    cleanup.push(() => canvas.removeEventListener(name, handler, options));
  };
  const modifiers = (event: MouseEvent | KeyboardEvent) =>
    [event.shiftKey && "shift", event.ctrlKey && "control", event.altKey && "alt", event.metaKey && "meta"].filter(
      Boolean,
    );
  const point = (event: MouseEvent) => {
    const r = canvas.getBoundingClientRect(),
      scale = r.width / p.width;
    return { x: Math.round((event.clientX - r.left) / scale), y: Math.round((event.clientY - r.top) / scale) };
  };
  const inputQueue = (p.inputQueue = new RemoteBrowserInputQueue(
    async (input, current) => {
      const generation = p.controlGeneration;
      const token =
        p.control.controller && p.control.kind === "human"
          ? p.control.token
          : p.acquiring?.kind === "human"
            ? await p.acquiring.promise
            : undefined;
      if (!current() || !token || generation !== p.controlGeneration || !host.acceptsInput(p)) return;
      const { document, ...event } = input;
      await host.call(p, "input", event, token, document);
    },
    () => {
      // Too many non-coalescible edges: cancel the gesture, never discard only
      // its release. Normal motion/wheel bursts stay bounded by merging.
      p.resetInput();
      if (p.control.controller && p.control.kind === "human")
        void host.call(p, "input", { type: "touchCancel" }).catch(() => {});
    },
    (error) => {
      p.resetPointers();
      p.ime?.retire();
      if (p.control.controller && p.control.kind === "human" && host.acceptsInput(p))
        void host.call(p, "input", { type: "touchCancel" }).catch(() => {});
      if (!["DOCUMENT_CHANGED", "CONTROL_LOST", "PAGE_CLOSED"].includes((error as BrowserAutomationError).code))
        host.inputError(p, "edit", "Browser input failed; try the interaction again");
    },
    () => (p.adaptiveInput ? p.inputPolicy.limit : 2),
  ));
  const send = (input: any) => {
    if (host.acceptsInput(p) && ((p.control.controller && p.control.kind === "human") || p.acquiring?.kind === "human"))
      inputQueue.push({ ...input, document: p.document });
  };
  let move: PointerEvent | null = null,
    raf = 0,
    touchMotion: any = null;
  const captured = new Set<number>();
  const contacts = new Map<
    number,
    { id: number; x: number; y: number; radiusX: number; radiusY: number; force: number }
  >();
  const contact = (event: PointerEvent, id = contacts.get(event.pointerId)!.id) => {
    const r = canvas.getBoundingClientRect(),
      scale = r.width / p.width;
    return {
      id,
      ...point(event),
      radiusX: Math.min(1000, (event.width || 2) / scale / 2),
      radiusY: Math.min(1000, (event.height || 2) / scale / 2),
      force: event.pressure,
    };
  };
  const touchFrame = (type: string, event: PointerEvent) => ({
    type,
    time: event.timeStamp,
    touchPoints: [...contacts.values()],
    modifiers: modifiers(event),
    menuIntent: p.menuIntent,
  });
  const sendTouch = (type: string, event: PointerEvent) => send(touchFrame(type, event));
  const sampleTouch = (event: PointerEvent) => {
    contacts.set(event.pointerId, contact(event));
    const sample = touchFrame("touchMove", event);
    touchMotion = touchMotion ? mergeTouchMoves(touchMotion, sample) : sample;
  };
  const flushMove = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    if (touchMotion) {
      send(touchMotion);
      touchMotion = null;
    }
    if (move) {
      send({
        type: "mouseMove",
        ...point(move),
        pointerType: move.pointerType,
        modifiers: [...modifiers(move), ...(move.buttons & 1 ? ["leftButtonDown"] : [])],
      });
      move = null;
    }
  };
  p.resetPointers = () => {
    move = null;
    touchMotion = null;
    contacts.clear();
    cancelAnimationFrame(raf);
    raf = 0;
    p.gestureActive = false;
    const ids = [...captured];
    captured.clear();
    for (const id of ids) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  };
  listen("pointermove", (event: PointerEvent) => {
    if (!host.acceptsPointer(p)) return;
    const intent = p.keyboardIntent;
    if (intent && Math.hypot(event.clientX - intent.x, event.clientY - intent.y) > 10) p.keyboardIntent = null;
    if (event.pointerType === "touch" && p.multiTouch) {
      if (!contacts.has(event.pointerId)) return;
      const coalesced = event.getCoalescedEvents?.();
      for (const sample of coalesced?.length ? coalesced : [event]) sampleTouch(sample);
    } else {
      if (event.pointerType === "touch" && !event.isPrimary) return;
      move = event;
    }
    if (!raf) raf = requestAnimationFrame(flushMove);
  });
  listen("pointerdown", (event: PointerEvent) => {
    if (!host.acceptsPointer(p)) return;
    if (event.pointerType === "touch" && !p.multiTouch && !event.isPrimary) return;
    event.preventDefault();
    flushMove();
    if (event.pointerType === "touch" && p.multiTouch && (contacts.has(event.pointerId) || contacts.size >= 10)) return;
    void host.acquireControl(p, "human").catch((error) => host.inputError(p, "control", error.message));
    p.gestureActive = true;
    p.ime?.retire();
    p.keyboardIntent =
      event.pointerType === "touch" && event.isPrimary && captured.size === 0
        ? { pointer: event.pointerId, x: event.clientX, y: event.clientY, editor: p.editor, until: 0, completed: false }
        : null;
    receiver.focus({ preventScroll: true });
    captured.add(event.pointerId);
    canvas.setPointerCapture(event.pointerId);
    host.retireMenu(p);
    p.menuIntent = crypto.randomUUID();
    if (event.pointerType === "touch" && p.multiTouch) {
      // Local IDs belong to the viewer (iOS uses unsigned random IDs). Only
      // bounded per-contact slots cross the signed native protocol boundary.
      const used = new Set([...contacts.values()].map((point) => point.id));
      let id = 0;
      while (used.has(id)) id++;
      contacts.set(event.pointerId, contact(event, id));
      sendTouch("touchStart", event);
    } else
      send({
        type: "mouseDown",
        ...point(event),
        pointerType: event.pointerType,
        menuIntent: p.menuIntent,
        button: ["left", "middle", "right"][event.button],
        clickCount: event.detail || 1,
        modifiers: modifiers(event),
      });
  });
  listen("pointerup", (event: PointerEvent) => {
    if (event.pointerType === "touch" && p.multiTouch) {
      if (!contacts.has(event.pointerId)) return;
      const previous = contacts.get(event.pointerId)!,
        released = contact(event);
      // Up is an edge, not a new stationary motion sample. Preserve a real
      // changed release location once, with its original event time.
      if (released.x !== previous.x || released.y !== previous.y) sampleTouch(event);
      flushMove();
      contacts.delete(event.pointerId);
      sendTouch("touchEnd", event);
    } else {
      if (event.pointerType === "touch" && !event.isPrimary) return;
      flushMove();
      send({
        type: "mouseUp",
        ...point(event),
        pointerType: event.pointerType,
        button: ["left", "middle", "right"][event.button],
        clickCount: event.detail || 1,
        modifiers: modifiers(event),
      });
    }
    if (
      p.keyboardIntent?.pointer === event.pointerId &&
      Math.hypot(event.clientX - p.keyboardIntent.x, event.clientY - p.keyboardIntent.y) <= 10
    ) {
      p.keyboardIntent.completed = true;
      p.keyboardIntent.until = performance.now() + 2000;
      host.updateKeyboard(p);
    }
    captured.delete(event.pointerId);
    if (!captured.size) {
      p.gestureActive = false;
      host.queueViewport(p);
    }
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  });
  const cancel = () => {
    p.keyboardIntent = null;
    inputQueue.reset();
    p.resetPointers();
    // Cancellation must not wait behind sampled motion, nor be erased by a
    // following blur/reset. Already-dispatched work stays ordered natively.
    if (host.acceptsInput(p) && p.control.controller && p.control.kind === "human")
      void host.call(p, "input", { type: "touchCancel" }).catch(() => {});
  };
  listen("pointercancel", (event: PointerEvent) => {
    if (captured.has(event.pointerId)) cancel();
  });
  listen("lostpointercapture", (event: PointerEvent) => {
    if (captured.has(event.pointerId)) cancel();
  });
  window.addEventListener("blur", cancel);
  cleanup.push(() => window.removeEventListener("blur", cancel));
  const visibility = () => {
    host.syncVisibility(p);
  };
  document.addEventListener("visibilitychange", visibility);
  cleanup.push(() => document.removeEventListener("visibilitychange", visibility));
  listen("contextmenu", (event) => event.preventDefault());
  listen(
    "wheel",
    (event: WheelEvent) => {
      event.preventDefault();
      if (!host.acceptsPointer(p)) return;
      void host.acquireControl(p, "human").catch((error) => host.inputError(p, "control", error.message));
      host.retireMenu(p);
      send({
        type: "mouseWheel",
        ...point(event),
        deltaX: -event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1),
        deltaY: -event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1),
        modifiers: modifiers(event),
      });
    },
    { passive: false },
  );
  const ime = (p.ime = new RemoteBrowserIme(
    receiver,
    (input) => host.call(p, "ime", input),
    () => host.acceptsInput(p) && p.control.controller && p.control.kind === "human",
    (message, error) => {
      const code = (error as BrowserAutomationError | undefined)?.code;
      host.inputError(
        p,
        code === "INPUT_TARGET_CHANGED" ? "focus" : code === "CONTROL_LOST" ? "control" : "edit",
        message,
      );
    },
    () => p.editor,
  ));
  const textListen = (name: string, handler: (event: any) => void) => {
    receiver.addEventListener(name, handler);
    cleanup.push(() => receiver.removeEventListener(name, handler));
  };
  const editing = new RemoteBrowserEditInput(
    receiver,
    () => host.acceptsInput(p) && p.control.controller && p.control.kind === "human",
    () => ime.composing,
    (text) => ime.commit(text),
    (keyCode) => {
      send({ type: "keyDown", keyCode });
      if (keyCode === "Return") send({ type: "char", keyCode: "\r" });
      send({ type: "keyUp", keyCode });
    },
  );
  p.resetInput = () => {
    inputQueue.reset();
    p.resetPointers();
    editing.retire();
    ime.retire();
  };
  textListen("blur", () => {
    cancel();
    p.resetInput();
    receiver.inputMode = "none";
    receiver.setAttribute("virtualkeyboardpolicy", "manual");
  });
  textListen("compositionstart", () => {
    editing.retire();
    ime.start();
  });
  textListen("compositionupdate", (event: CompositionEvent) => ime.update(event.data));
  textListen("compositionend", (event: CompositionEvent) => ime.end(event.data));
  textListen("beforeinput", (event: InputEvent) => editing.beforeInput(event));
  textListen("input", (event: InputEvent) => editing.input(event));
  textListen("paste", (event: ClipboardEvent) => {
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain");
    if (text && host.acceptsInput(p)) ime.commit(text.slice(0, 10000));
  });
  const keys: Record<string, string> = {
    Enter: "Return",
    Escape: "Escape",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    ArrowUp: "Up",
    ArrowDown: "Down",
    " ": "Space",
  };
  textListen("keydown", (event: KeyboardEvent) => {
    if (!p.control.controller || p.control.kind !== "human") return;
    if (ime.composing || event.isComposing || ["Process", "Unidentified"].includes(event.key) || event.keyCode === 229)
      return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      event.preventDefault();
      if (!event.repeat && host.acceptsInput(p)) {
        if (p.nativeCopy) host.copyCurrent(p);
        else host.inputError(p, "copy", "This browser runtime does not support copying yet");
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
    host.retireMenu(p);
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) p.menuIntent = crypto.randomUUID();
    event.preventDefault();
    send({
      type: "keyDown",
      keyCode: keys[event.key] || event.key,
      menuIntent: p.menuIntent,
      modifiers: modifiers(event),
    });
    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey)
      send({ type: "char", keyCode: "\r", modifiers: modifiers(event) });
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey)
      send({ type: "char", keyCode: event.key });
  });
  textListen("keyup", (event: KeyboardEvent) => {
    if (ime.composing || event.isComposing || ["Process", "Unidentified"].includes(event.key) || event.keyCode === 229)
      return;
    if ((event.ctrlKey || event.metaKey) && ["c", "v"].includes(event.key.toLowerCase())) return;
    event.preventDefault();
    send({ type: "keyUp", keyCode: keys[event.key] || event.key, modifiers: modifiers(event) });
  });
  return () => {
    p.resetInput();
    cleanup.forEach((dispose) => dispose());
  };
}
