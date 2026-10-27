import { bindDesktopTrackpad } from "./trackpad-input";
import { classifyTwoFinger, constrainView, DesktopScrollPolicy, fitView, framebufferPoint, zoomAround,
  type Point, type TouchIntent, type ViewTransform } from "./input-policy";
import type { RfbClient } from "./rfb-client";

const middle = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const mouseMask = (buttons: number) => (buttons & 1) | (buttons & 2 ? 4 : 0) | (buttons & 4 ? 2 : 0);

/** Only pointer/scroll owner. Decoder still owns rendering and hardware keys.
 * A two-finger sample is interpreted once per frame, not once per finger.
 * Reset cancels that sample; every packet checks the current confirmed lease. */
export function bindDesktopPointerInput(element: HTMLElement, client: RfbClient,
  allowed: () => boolean, beforeRemotePress: () => void = () => client.focus({ preventScroll: true })) {
  const canvas = client.getInputCanvas();
  const scroll = new DesktopScrollPolicy();
  const touches = new Map<number, Point>();
  const disposers: (() => void)[] = [];
  let view: ViewTransform = fitView;
  let single: { id: number; start: Point; last: Point; moved: boolean; remote: boolean } | null = null;
  let pair: { center: Point; focal: Point; distance: number; view: ViewTransform; intent: TouchIntent; last: Point } | null = null;
  let suppressed = false;
  let retiredTouches = false;
  let heldMouse: number | null = null;
  let retiredMouse: number | null = null;
  let lastRemote: Point | null = null;
  let relativePosition: Point | null = null;
  const trackpads = new Set<ReturnType<typeof bindDesktopTrackpad>>();
  let buttons = 0;
  let trackpadPress = false;
  let disposed = false;
  let pairFrame: number | null = null;
  let inputEpoch = 0;
  // Physical gestures belong to the geometry in which they started. A mobile
  // keyboard/Shell resize cancels them, not the longer-lived control grant.
  const geometry = () => {
    const rect = element.getBoundingClientRect();
    return [rect.x, rect.y, rect.width, rect.height, element.clientWidth, element.clientHeight, canvas.width, canvas.height];
  };
  let gestureGeometry: number[] | null = null;
  let pressBounds: number[] | null = null;
  const canvasBounds = () => { const rect = canvas.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height]; };
  const equal = (a: number[], b: number[]) => a.every((value, index) => Math.abs(value - b[index]!) < 0.01);
  const changedGeometry = () => gestureGeometry !== null && (!equal(gestureGeometry, geometry())
    || (single?.remote === true || heldMouse !== null) && pressBounds !== null && !equal(pressBounds, canvasBounds()));
  const clock = element.ownerDocument?.defaultView;
  const saved = { transform: canvas.style.transform, origin: canvas.style.transformOrigin,
    touch: element.style.touchAction };
  element.style.touchAction = "none";
  canvas.style.transformOrigin = "center";
  client.setPointerInputManaged(true);

  const local = (event: PointerEvent): Point => ({ x: event.clientX, y: event.clientY });
  const mediaSize = () => { const rect = canvas.getBoundingClientRect();
    return { width: rect.width / view.scale, height: rect.height / view.scale }; };
  const paint = (next: ViewTransform) => {
    view = constrainView(next, mediaSize(), { width: element.clientWidth, height: element.clientHeight });
    canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  };
  const point = (position: Point, clamp = false) => {
    const rect = canvas.getBoundingClientRect();
    return framebufferPoint(position, rect, canvas.width, canvas.height, clamp);
  };
  const focalOffset = (position: Point) => {
    const rect = canvas.getBoundingClientRect();
    return { x: position.x - rect.x - rect.width / 2 + view.x,
      y: position.y - rect.y - rect.height / 2 + view.y };
  };
  const write = (position: Point, mask: number, clamp = false) => {
    if (disposed || !allowed()) return;
    const remote = point(position, clamp); if (!remote) return;
    lastRemote = remote; relativePosition = remote; client.sendPointer(remote.x, remote.y, mask, position.x, position.y);
  };
  const releasePointer = () => {
    // Release only within the still-current grant, never under a successor.
    if (buttons && lastRemote && allowed() && !disposed && canvas.width > 0 && canvas.height > 0) {
      client.sendPointer(Math.min(lastRemote.x, canvas.width - 1), Math.min(lastRemote.y, canvas.height - 1), 0);
    }
    buttons = 0; heldMouse = null;
  };
  const stop = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const capture = (id: number) => { try { element.setPointerCapture(id); } catch { /* Detached pointer. */ } };
  const unCapture = (id: number) => { try { element.releasePointerCapture(id); } catch { /* Already lost. */ } };
  const scrollAt = (position: Point, x: number, y: number, mode: number) => {
    if (disposed || !allowed() || !point(position)) { scroll.reset(); return; }
    for (const mask of scroll.consume(x, y, mode, performance.now())) {
      write(position, buttons | mask); write(position, buttons);
    }
  };
  const wheel = (event: WheelEvent) => {
    stop(event);
    // Trackpad pinch is local viewing, including while in control.
    if (event.ctrlKey) {
      paint(zoomAround(view, focalOffset({ x: event.clientX, y: event.clientY }),
        view.scale * Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) / 200))); return;
    }
    scrollAt({ x: event.clientX, y: event.clientY }, event.deltaX, event.deltaY, event.deltaMode);
  };
  const down = (event: PointerEvent) => {
    if (changedGeometry()) reset();
    for (const trackpad of trackpads) trackpad.reset();
    if (event.pointerType !== "touch") {
      if (retiredMouse !== null || touches.size > 0) return;
      if (!allowed() || !point(local(event)) || heldMouse !== null && heldMouse !== event.pointerId) return;
      stop(event); heldMouse = event.pointerId; capture(event.pointerId); gestureGeometry = geometry(); pressBounds = canvasBounds();
      const epoch = inputEpoch;
      beforeRemotePress();
      if (inputEpoch !== epoch || !allowed()) return;
      buttons = mouseMask(event.buttons); write(local(event), buttons); return;
    }
    stop(event); capture(event.pointerId); touches.set(event.pointerId, local(event));
    if (retiredTouches) return;
    if (touches.size === 1 && !suppressed) {
      // A touch transaction replaces, rather than inherits, a mouse drag.
      if (heldMouse !== null) { retiredMouse = heldMouse; releasePointer(); }
      const position = local(event);
      single = { id: event.pointerId, start: position, last: position, moved: false, remote: allowed() && point(position) !== null };
      gestureGeometry = geometry(); pressBounds = canvasBounds();
    } else if (touches.size === 2) {
      releasePointer(); single = null; suppressed = true; scroll.reset();
      const [a, b] = [...touches.values()] as [Point, Point]; const center = middle(a, b);
      pair = { center, focal: focalOffset(center), distance: distance(a, b), view, intent: "undecided", last: center };
    } else { releasePointer(); pair = null; single = null; suppressed = true; }
  };
  const processPair = () => {
    if (disposed || !pair || touches.size !== 2) return;
    const [a, b] = [...touches.values()] as [Point, Point]; const center = middle(a, b);
    const currentDistance = distance(a, b);
    if (pair.intent === "undecided") pair.intent = classifyTwoFinger(currentDistance - pair.distance,
      { x: center.x - pair.center.x, y: center.y - pair.center.y });
    if (pair.intent === "zoom" || !allowed()) {
      const zoomed = zoomAround(pair.view, pair.focal,
        pair.distance > 0 ? pair.view.scale * currentDistance / pair.distance : pair.view.scale);
      paint({ ...zoomed, x: zoomed.x + center.x - pair.center.x, y: zoomed.y + center.y - pair.center.y });
    } else if (pair.intent === "scroll") {
      scrollAt(pair.center, pair.last.x - center.x, pair.last.y - center.y, 0);
    }
    pair.last = center;
  };
  const cancelPairFrame = () => { if (pairFrame !== null) clock?.cancelAnimationFrame(pairFrame); pairFrame = null; };
  const flushPair = () => { cancelPairFrame(); processPair(); };
  const move = (event: PointerEvent) => {
    if (changedGeometry()) reset();
    if (event.pointerType !== "touch") {
      if (retiredMouse !== null) { if (!event.buttons) retiredMouse = null; else return; }
      if (touches.size > 0) return;
      if (heldMouse !== null && heldMouse !== event.pointerId) return;
      if (allowed()) { stop(event); write(local(event), buttons, heldMouse !== null); }
      return;
    }
    stop(event); if (!touches.has(event.pointerId) || retiredTouches) return;
    touches.set(event.pointerId, local(event));
    if (pair && touches.size === 2) {
      if (clock?.requestAnimationFrame) {
        if (pairFrame === null) pairFrame = clock.requestAnimationFrame(() => { pairFrame = null; processPair(); });
      } else processPair();
      return;
    }
    if (!single || single.id !== event.pointerId || suppressed) return;
    const position = local(event);
    if (!single.moved && distance(position, single.start) >= 8) single.moved = true;
    if (single.remote && allowed() && single.moved) {
      if (!buttons) {
        const epoch = inputEpoch, origin = single.start;
        beforeRemotePress();
        if (inputEpoch !== epoch || !allowed()) return;
        buttons = 1; write(origin, buttons);
      }
      write(position, buttons, true);
    } else if (!single.remote && single.moved) {
      paint({ ...view, x: view.x + position.x - single.last.x, y: view.y + position.y - single.last.y });
    }
    single.last = position;
  };
  const end = (event: PointerEvent) => {
    if (changedGeometry()) reset();
    if (event.pointerType !== "touch") {
      if (retiredMouse === event.pointerId) {
        stop(event); if (!event.buttons || event.type !== "pointerup") { retiredMouse = null; unCapture(event.pointerId); }
        return;
      }
      if (heldMouse !== event.pointerId) return;
      stop(event);
      if (event.type === "pointerup" && event.buttons) {
        buttons = mouseMask(event.buttons); write(local(event), buttons, true); return;
      }
      releasePointer(); gestureGeometry = null; pressBounds = null; unCapture(event.pointerId); return;
    }
    stop(event);
    if (event.type === "pointerup") flushPair(); else cancelPairFrame();
    if (single?.id === event.pointerId && !suppressed && event.type === "pointerup") {
      if (single.remote && !single.moved && allowed()) {
        const epoch = inputEpoch;
        beforeRemotePress();
        if (inputEpoch === epoch && allowed()) { write(local(event), 1); write(local(event), 0); }
      }
    }
    // Cancelling never commits a tap, and the remaining finger of a pair
    // cannot turn into a remote drag/click.
    releasePointer(); touches.delete(event.pointerId); single = null; pair = null;
    if (!touches.size) { suppressed = false; retiredTouches = false; gestureGeometry = null; pressBounds = null; }
    scroll.reset(); unCapture(event.pointerId);
  };
  const listen = (name: string, listener: EventListener) => {
    element.addEventListener(name, listener, { capture: true, passive: false });
    disposers.push(() => element.removeEventListener(name, listener, true));
  };
  listen("wheel", wheel as EventListener);
  listen("pointerdown", down as EventListener); listen("pointermove", move as EventListener);
  listen("pointerup", end as EventListener); listen("pointercancel", end as EventListener);
  listen("lostpointercapture", event => {
    const pointer = event as PointerEvent;
    if (touches.has(pointer.pointerId) || heldMouse === pointer.pointerId) end(pointer);
  });
  // The managed decoder doesn't forward these. Also suppress browser gestures
  // and compatibility mouse sequences so there cannot be a second input owner.
  for (const name of ["touchstart", "touchmove", "touchend", "touchcancel", "mousedown", "mouseup", "mousemove", "contextmenu"]) listen(name, stop);
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
    if (disposed) return;
    if (changedGeometry()) reset();
    paint(view);
  });
  observer?.observe(element);
  const resetDirect = () => {
    inputEpoch++;
    if (heldMouse !== null) retiredMouse = heldMouse;
    cancelPairFrame(); releasePointer(); single = null; pair = null; scroll.reset();
    gestureGeometry = null; pressBounds = null;
    // Retained physical fingers must all lift before a new grant accepts them.
    suppressed = touches.size > 0;
    retiredTouches = touches.size > 0;
  };
  const reset = () => {
    resetDirect();
    for (const trackpad of trackpads) trackpad.reset();
    relativePosition = lastRemote = null;
  };
  const writeRelative = (mask: number) => {
    if (disposed || !allowed() || canvas.width <= 0 || canvas.height <= 0) return;
    const position = relativePosition ?? lastRemote ?? { x: canvas.width / 2, y: canvas.height / 2 };
    relativePosition = { x: Math.min(canvas.width - 1, Math.max(0, position.x)), y: Math.min(canvas.height - 1, Math.max(0, position.y)) };
    lastRemote = { x: Math.floor(relativePosition.x), y: Math.floor(relativePosition.y) };
    const rect = canvas.getBoundingClientRect();
    client.sendPointer(lastRemote.x, lastRemote.y, mask,
      rect.x + (lastRemote.x + .5) / canvas.width * rect.width,
      rect.y + (lastRemote.y + .5) / canvas.height * rect.height);
  };
  return { reset, attachTrackpad(pad: HTMLElement) {
    const input = bindDesktopTrackpad(pad, {
      allowed: () => !disposed && allowed() && !changedGeometry(),
      begin: () => { resetDirect(); gestureGeometry = geometry(); },
      move: delta => {
        const rect = canvas.getBoundingClientRect();
        if (!(rect.width > 0)) return;
        const position = relativePosition ?? lastRemote ?? { x: canvas.width / 2, y: canvas.height / 2 };
        const gain = canvas.width / rect.width * 1.25;
        relativePosition = { x: position.x + delta.x * gain, y: position.y + delta.y * gain };
        writeRelative(buttons);
      },
      press: mask => {
        const epoch = inputEpoch; beforeRemotePress();
        if (epoch !== inputEpoch || !allowed()) return;
        trackpadPress = true; buttons = mask; writeRelative(mask);
      },
      release: () => { if (trackpadPress) { trackpadPress = false; releasePointer(); } },
      scroll: delta => {
        for (const mask of scroll.consume(delta.x, delta.y, 0, performance.now())) {
          writeRelative(mask); writeRelative(0);
        }
      },
    });
    trackpads.add(input);
    return () => { input.dispose(); trackpads.delete(input); };
  }, dispose() {
    if (disposed) return;
    reset(); for (const pad of trackpads) pad.dispose(); trackpads.clear(); disposed = true; observer?.disconnect();
    for (const dispose of disposers) dispose(); touches.clear();
    canvas.style.transform = saved.transform; canvas.style.transformOrigin = saved.origin;
    element.style.touchAction = saved.touch;
    // Decoder is disposed by its connection, never re-enable its old writers.
  } };
}
