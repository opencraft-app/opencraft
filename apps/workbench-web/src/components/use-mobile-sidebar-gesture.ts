import { animate, useMotionValue, useReducedMotion, type MotionValue } from "motion/react";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { PANEL_SPRING_TRANSITION } from "./use-panel-animation";
import { MOBILE_SIDEBAR_EDGE_RESERVE, MOBILE_SIDEBAR_REVEAL_DIRECTION, MOBILE_GESTURE_COMPETITION, MOBILE_GESTURE_DEADZONE, arbitrateMobileGesture, mobileGestureAdmissionVelocity, mobileGestureVelocity, sidebarReleaseVelocity, sidebarGestureAxis, sidebarGestureProgress, sidebarGestureTarget, type GestureSample, type MobileGestureOwner } from "./mobile-sidebar-gesture";

interface HorizontalScroll {
  element: HTMLElement; start: number; min: number; max: number;
}

interface Gesture {
  id: number; x: number; y: number; width: number; start: number; initiallyOpen: boolean;
  owner: MobileGestureOwner; sidebarAllowed: boolean; horizontal: HorizontalScroll | null; scrollports: HorizontalScroll[];
  motionStartedAt: number | null; samples: GestureSample[];
}

const foregroundInputSelector = 'dialog[open],[aria-modal="true"],[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]';

function hasForegroundInputOwner(shell: HTMLElement, path: EventTarget[] = []): boolean {
  if (path.some(node => node instanceof Element && node.matches(foregroundInputSelector))) return true;
  // Portals live in the presentation's own DOM root. Document queries cannot
  // see embedded dialogs; a retargeted event.target cannot identify their input.
  const scope = shell.getRootNode() as Document | ShadowRoot;
  const scopes = scope === shell.ownerDocument ? [scope] : [scope, shell.ownerDocument];
  return scopes.some(root => [...root.querySelectorAll(foregroundInputSelector)].some(node =>
    node.getClientRects().length > 0 && (node.matches('dialog:modal') || !node.closest('[hidden],[inert],[aria-hidden="true"]'))));
}

function horizontalInput(path: EventTarget[], boundary: HTMLElement): HorizontalScroll[] | "exclusive" {
  const horizontal: HorizontalScroll[] = [];
  for (const node of path) {
    if (node === boundary) break;
    if (!(node instanceof Element)) continue;
    if (node.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="slider"],[role="scrollbar"],[draggable="true"],iframe,canvas,video,audio,.xterm,[data-sidebar-gesture="ignore"],[role="dialog"],[role="menu"],[role="listbox"]')) return "exclusive";
    if (node instanceof HTMLElement && node.scrollWidth > node.clientWidth + 1
      && /auto|scroll/.test(getComputedStyle(node).overflowX)) {
      const extent = node.scrollWidth - node.clientWidth;
      const rtl = getComputedStyle(node).direction === "rtl";
      horizontal.push({ element: node, start: node.scrollLeft, min: rtl ? -extent : 0, max: rtl ? 0 : extent });
    }
  }
  return horizontal;
}

/** One visibility writer above the shared portal. Vertical/native input stays owned by its view. */
export function useMobileSidebarGesture({ enabled, open, width, root, overlay, onOpenChange }: {
  enabled: boolean; open: boolean; width: MotionValue<number>;
  root: RefObject<HTMLElement | null>; overlay: RefObject<HTMLElement | null>;
  onOpenChange(open: boolean): void;
}) {
  const reducedMotion = useReducedMotion() === true;
  const progress = useMotionValue(enabled && open ? 1 : 0);
  const [present, setPresent] = useState(enabled && open);
  const [dragging, setDragging] = useState(false);
  const latest = useRef({ open, onOpenChange, reducedMotion });
  latest.current = { open, onOpenChange, reducedMotion };
  const gesture = useRef<Gesture | null>(null);
  const generation = useRef(0);
  const target = useRef<boolean | null>(null);
  const suppressClick = useRef(0);
  const settle = (next: boolean) => {
    const receipt = ++generation.current;
    progress.stop();
    target.current = next;
    if (next) setPresent(true);
    const finish = () => { if (generation.current === receipt && !next) setPresent(false); };
    if (latest.current.reducedMotion) { progress.set(next ? 1 : 0); finish(); }
    else animate(progress, next ? 1 : 0, { ...PANEL_SPRING_TRANSITION, bounce: 0, onComplete: finish });
  };
  const settleRef = useRef(settle);
  settleRef.current = settle;

  useLayoutEffect(() => {
    gesture.current = null;
    setDragging(false);
    if (!enabled) { ++generation.current; progress.stop(); progress.set(0); setPresent(false); target.current = null; }
    else if (target.current !== open || reducedMotion) settleRef.current(open);
  }, [enabled, open, reducedMotion, progress]);

  useLayoutEffect(() => {
    if (!enabled) return;
    let scrolling: ReturnType<typeof animate> | null = null;
    const stopContentMotion = () => { scrolling?.stop(); scrolling = null; };
    const cancel = (immediate = false) => {
      stopContentMotion();
      if (!gesture.current) return;
      const { initiallyOpen: previous, owner } = gesture.current;
      if (owner === "sidebar" || owner === "content") suppressClick.current = performance.now() + 500;
      gesture.current = null; setDragging(false);
      if (owner !== "sidebar") return;
      if (immediate) {
        ++generation.current; progress.stop(); target.current = previous;
        progress.set(previous ? 1 : 0); setPresent(previous);
      } else settleRef.current(previous);
    };
    const foregroundOwnsInput = (event?: Event) => {
      const shell = root.current;
      if (!shell || !hasForegroundInputOwner(shell, event?.composedPath())) return false;
      cancel(true);
      // Native showModal may dispatch touchcancel before its open mutation is
      // observed. Revoke that already-settling background animation as well.
      if (target.current !== null) {
        ++generation.current; progress.stop();
        progress.set(target.current ? 1 : 0); setPresent(target.current);
      }
      // A newly opened input layer owns its clicks too, including the first
      // close/navigation action after revoking an in-flight Shell contact.
      suppressClick.current = 0;
      return true;
    };
    const start = (event: TouchEvent) => {
      stopContentMotion();
      // A fresh deliberate tap must remain usable immediately after a swipe.
      suppressClick.current = 0;
      if (event.touches.length !== 1) { cancel(); return; }
      const shell = root.current, surface = overlay.current;
      if (!shell) return;
      const path = event.composedPath();
      const boundary = surface && path.includes(surface) ? surface : shell && path.includes(shell) ? shell : null;
      if (!boundary || foregroundOwnsInput(event) || window.getSelection()?.toString()) return;
      const scrollports = horizontalInput(path, boundary);
      if (scrollports === "exclusive") return;
      const horizontal = scrollports[0] ?? null;
      // Clickable content (reasoning disclosures, image previews, links) can
      // also start a swipe. Axis locking preserves taps/vertical scrolling;
      // the recognized drag suppresses its click in end/cancel below.
      const touch = event.touches[0]!;
      const viewport = shell.getBoundingClientRect();
      // Leave both screen edges to browser/OS navigation gestures.
      const sidebarAllowed = touch.clientX >= viewport.left + MOBILE_SIDEBAR_EDGE_RESERVE && touch.clientX <= viewport.right - MOBILE_SIDEBAR_EDGE_RESERVE;
      if (!sidebarAllowed && !horizontal) return;
      gesture.current = { id: touch.identifier, x: touch.clientX, y: touch.clientY, width: width.get(), start: progress.get(), initiallyOpen: latest.current.open, owner: "pending", sidebarAllowed, horizontal, scrollports, motionStartedAt: null, samples: [{ x: touch.clientX, time: event.timeStamp }] };
    };
    const move = (event: TouchEvent) => {
      const transaction = gesture.current;
      if (!transaction) return;
      if (foregroundOwnsInput(event)) return;
      if (event.touches.length !== 1) { cancel(); return; }
      if (window.getSelection()?.toString()) { cancel(); return; }
      const touch = Array.from(event.touches).find(t => t.identifier === transaction.id);
      if (!touch) { cancel(); return; }
      const dx = touch.clientX - transaction.x, dy = touch.clientY - transaction.y;
      // Native scrolling already owns a non-cancelable competing sequence.
      if (transaction.horizontal && !event.cancelable) { cancel(); return; }
      if (transaction.horizontal && !transaction.horizontal.element.isConnected) { cancel(); return; }
      if (transaction.motionStartedAt === null && Math.max(Math.abs(dx), Math.abs(dy)) >= MOBILE_GESTURE_DEADZONE) {
        transaction.motionStartedAt = event.timeStamp;
        // Time at rest is not slow movement. The next motion sample supplies
        // speed when the first movement arrives after a stationary interval.
        if (event.timeStamp - transaction.samples[0]!.time > MOBILE_GESTURE_COMPETITION.sampleWindow) transaction.samples = [];
      }
      const velocity = mobileGestureAdmissionVelocity(transaction.samples, touch.clientX, event.timeStamp, transaction.motionStartedAt);
      transaction.samples.push({ x: touch.clientX, time: event.timeStamp });
      while (transaction.samples.length > 2 && transaction.samples[1]!.time < event.timeStamp - 100) transaction.samples.shift();
      // Resolve the innermost viewport that can read in this direction before
      // committing. An exhausted nested viewport must not hide a readable parent.
      if (transaction.owner === "pending") transaction.horizontal = transaction.scrollports.find(port =>
        dx > 0 ? port.start > port.min + 1 : port.start < port.max - 1) ?? transaction.scrollports[0] ?? null;
      const horizontal = transaction.horizontal;
      const owner = arbitrateMobileGesture({
        owner: transaction.owner, dx, dy, elapsed: transaction.motionStartedAt === null ? 0 : event.timeStamp - transaction.motionStartedAt, velocity,
        sidebarAllowed: transaction.sidebarAllowed, initiallyOpen: transaction.initiallyOpen,
        horizontalContent: horizontal !== null,
        contentCanScroll: horizontal !== null && (dx > 0 ? horizontal.start > horizontal.min + 1 : horizontal.start < horizontal.max - 1),
      });
      if (owner === "native") { gesture.current = null; return; }
      if (owner === "pending") {
        // Reserve a recognized horizontal contact while deciding its writer.
        // Cancel the first direction-locked move, before native panning starts.
        // No component marker or ancestor touch-action restriction is required.
        if (horizontal && sidebarGestureAxis(dx, dy) === "horizontal" && event.cancelable) event.preventDefault();
        return;
      }
      if (event.cancelable) event.preventDefault();
      if (owner === "content" && horizontal) {
        transaction.owner = owner;
        horizontal.element.scrollLeft = Math.max(horizontal.min, Math.min(horizontal.max, horizontal.start - dx));
        return;
      }
      if (transaction.owner !== "sidebar") {
        // During native scroll inertia a fresh horizontal sequence can already
        // be non-cancelable. It still owns drawer movement; only prevent the
        // browser default when supported, after the vertical/input exclusions.
        // Stop the old animation before reading its current position.
        progress.stop(); ++generation.current; target.current = null;
        transaction.start = progress.get(); transaction.owner = "sidebar";
        setPresent(true); setDragging(true);
      }
      progress.set(sidebarGestureProgress(transaction.start, dx, transaction.width));
    };
    const end = (event: TouchEvent) => {
      const transaction = gesture.current;
      if (!transaction || !Array.from(event.changedTouches).some(t => t.identifier === transaction.id)) return;
      if (foregroundOwnsInput(event)) return;
      gesture.current = null; setDragging(false);
      if (transaction.owner === "pending") {
        const touch = Array.from(event.changedTouches).find(t => t.identifier === transaction.id)!;
        const dx = touch.clientX - transaction.x, dy = touch.clientY - transaction.y;
        const horizontal = transaction.scrollports.find(port =>
          dx > 0 ? port.start > port.min + 1 : port.start < port.max - 1) ?? transaction.scrollports[0] ?? null;
        transaction.horizontal = horizontal;
        transaction.owner = arbitrateMobileGesture({
          owner: "pending", dx, dy, elapsed: 0, velocity: null, ended: true,
          sidebarAllowed: transaction.sidebarAllowed, initiallyOpen: transaction.initiallyOpen,
          horizontalContent: horizontal !== null,
          contentCanScroll: horizontal !== null && (dx > 0 ? horizontal.start > horizontal.min + 1 : horizontal.start < horizontal.max - 1),
        });
        // A one-sample contact finishes as local reading instead of disappearing.
        if (transaction.owner === "content" && horizontal?.element.isConnected) {
          horizontal.element.scrollLeft = Math.max(horizontal.min, Math.min(horizontal.max, horizontal.start - dx));
          if (event.cancelable) event.preventDefault();
          suppressClick.current = performance.now() + 500;
        }
        return;
      }
      if (event.cancelable) event.preventDefault();
      suppressClick.current = performance.now() + 500;
      const touch = Array.from(event.changedTouches).find(t => t.identifier === transaction.id)!;
      const velocity = mobileGestureVelocity(transaction.samples, touch.clientX, event.timeStamp);
      if (transaction.owner === "content") {
        const horizontal = transaction.horizontal;
        if (horizontal?.element.isConnected && !latest.current.reducedMotion && Math.abs(velocity) >= 0.1) {
          scrolling = animate(horizontal.element.scrollLeft, horizontal.element.scrollLeft, {
            type: "inertia", velocity: -velocity * 1000, power: 0.25, timeConstant: 280,
            modifyTarget: next => Math.max(horizontal.min, Math.min(horizontal.max, next)),
            onUpdate: next => { if (horizontal.element.isConnected) horizontal.element.scrollLeft = next; },
          });
        }
        return;
      }
      const next = sidebarGestureTarget(progress.get(), sidebarReleaseVelocity(transaction.samples, touch.clientX, event.timeStamp) * MOBILE_SIDEBAR_REVEAL_DIRECTION, touch.clientX - transaction.x, transaction.initiallyOpen);
      settleRef.current(next);
      if (next !== latest.current.open) latest.current.onOpenChange(next);
    };
    const click = (event: MouseEvent) => {
      if (performance.now() >= suppressClick.current) return;
      if (foregroundOwnsInput(event)) return;
      suppressClick.current = 0; event.preventDefault(); event.stopImmediatePropagation();
    };
    document.addEventListener("touchstart", start, { passive: true, capture: true });
    document.addEventListener("touchmove", move, { passive: false, capture: true });
    document.addEventListener("touchend", end, { passive: false, capture: true });
    const cancelContact = () => cancel();
    document.addEventListener("touchcancel", cancelContact, true);
    document.addEventListener("click", click, true);
    window.addEventListener("resize", cancelContact);
    // A modal appearing while the finger is held revokes the old gesture now,
    // rather than letting its later move/end write behind the foreground view.
    const foreground = new MutationObserver(() => { if (gesture.current || scrolling || (progress.get() > 0 && progress.get() < 1)) foregroundOwnsInput(); });
    const scope = root.current?.getRootNode();
    const observation = { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "aria-modal", "role", "hidden", "aria-hidden"] };
    if (scope) foreground.observe(scope, observation);
    if (scope !== document) foreground.observe(document, observation);
    return () => {
      stopContentMotion();
      foreground.disconnect();
      document.removeEventListener("touchstart", start, true); document.removeEventListener("touchmove", move, true);
      document.removeEventListener("touchend", end, true); document.removeEventListener("touchcancel", cancelContact, true);
      document.removeEventListener("click", click, true); window.removeEventListener("resize", cancelContact);
      gesture.current = null;
    };
  }, [enabled, overlay, root, progress, width]);
  useLayoutEffect(() => () => { ++generation.current; progress.stop(); }, [progress]);
  return { progress, present, dragging };
}
