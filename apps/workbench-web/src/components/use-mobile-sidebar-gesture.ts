import { useMotionReduction } from "@opencraft/design-system-web/motion-reduction";
import { animate, useMotionValue, type MotionValue } from "motion/react";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { PANEL_SPRING_TRANSITION, PANEL_CONTINUOUS_SPRING_TRANSITION } from "./use-panel-animation";
import { readEdgeGestureHandoff } from "../runtime/edge-gesture-bridge";
import { MOBILE_SIDEBAR_EDGE_RESERVE, MOBILE_SIDEBAR_REVEAL_DIRECTION, MOBILE_GESTURE_COMPETITION, MOBILE_GESTURE_DEADZONE, arbitrateMobileGesture, mobileGestureAdmissionVelocity, mobileGestureVelocity, sidebarReleaseVelocity, sidebarGestureAxis, sidebarGestureProgress, sidebarGestureTarget, type GestureSample, type MobileGestureOwner } from "./mobile-sidebar-gesture";

type ContactEvent = TouchEvent | PointerEvent;
function contacts(event: ContactEvent, changed = false) {
  return 'touches' in event ? Array.from(changed ? event.changedTouches : event.touches)
    : [{ identifier: event.pointerId, clientX: event.clientX, clientY: event.clientY }];
}

interface HorizontalScroll {
  element: HTMLElement; start: number; min: number; max: number;
}

interface Gesture {
  id: number; x: number; y: number; width: number; start: number; initiallyOpen: boolean;
  owner: MobileGestureOwner; sidebarAllowed: boolean; horizontal: HorizontalScroll | null; scrollports: HorizontalScroll[];
  motionStartedAt: number | null; samples: GestureSample[]; nativeReader: boolean; initialFocus?:HTMLElement|null;
}

const foregroundInputSelector = 'dialog[open],[aria-modal="true"],[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]';

function hasForegroundInputOwner(shell: HTMLElement, path: EventTarget[] = [], withinModal = false, ownedSurface?:HTMLElement|null): boolean {
  const ownDialog = withinModal ? shell.closest('[role="dialog"],[role="alertdialog"],dialog') : ownedSurface;
  // Only the enclosing modal is exempt. Nested dialogs, menus and listboxes
  // still revoke this local navigation gesture, as they do for the Shell.
  const foreign = (node: Element) => !ownDialog || !node.contains(ownDialog);
  if (path.some(node => node instanceof Element && node.matches(foregroundInputSelector) && foreign(node))) return true;
  // Portals live in the presentation's own DOM root. Document queries cannot
  // see embedded dialogs; a retargeted event.target cannot identify their input.
  const scope = shell.getRootNode() as Document | ShadowRoot;
  const scopes = scope === shell.ownerDocument ? [scope] : [scope, shell.ownerDocument];
  return scopes.some(root => [...root.querySelectorAll(foregroundInputSelector)].some(node =>
    foreign(node) && node.getClientRects().length > 0 && (node.matches('dialog:modal') || !node.closest('[hidden],[inert],[aria-hidden="true"]'))));
}

function horizontalInput(path: EventTarget[], boundary: HTMLElement): HorizontalScroll[] | "exclusive" {
  const horizontal: HorizontalScroll[] = [];
  // A native vertical reader can lend horizontal contacts to the existing Shell
  // owner. The nearest declaration wins; nested editors/media remain exclusive.
  const surface = path.slice(0, path.indexOf(boundary)).find(node =>
    node instanceof Element && node.hasAttribute('data-sidebar-gesture'));
  const verticalReader = surface instanceof Element && surface.getAttribute('data-sidebar-gesture') === 'vertical-pan' ? surface : null;
  for (const node of path) {
    if (node === boundary) break;
    if (!(node instanceof Element)) continue;
    if (node.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="slider"],[role="scrollbar"],[draggable="true"],iframe,video,audio,[data-sidebar-gesture="ignore"],[role="dialog"],[role="menu"],[role="listbox"]')
      || (node.matches('canvas,.xterm') && !verticalReader?.contains(node))) return "exclusive";
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
export function useMobileSidebarGesture({ enabled, open, width, root, overlay, foreground, emulateMouse = false, withinModal = false, intent = "sidebar", scopeKey, presentation, onOpenChange, leftEdgeOnly=false, excludeLeftEdge=false, edgeWidth=36, edgeHandle, onInteractionStart }: {
  /** Explicit interactive phone preview only; ordinary desktop mouse input stays native. */
  emulateMouse?: boolean;
  /** Local navigation may consume contacts inside its enclosing modal only. */
  withinModal?: boolean;
  intent?: "sidebar" | "back";
  /** A new Router entry revokes a held contact before it can act on the next page. */
  scopeKey?: string;
  /** Existing page presentation transfers its visible progress, or declines until ready. */
  presentation?: RefObject<{ acquire(): number | null } | null>;
  enabled: boolean; open: boolean; width: MotionValue<number>;
  root: RefObject<HTMLElement | null>; overlay: RefObject<HTMLElement | null>;
  foreground?: RefObject<HTMLElement | null>;
  onOpenChange(open: boolean): boolean | void;
  onInteractionStart?(focused:HTMLElement|null):void;
  leftEdgeOnly?:boolean; excludeLeftEdge?:boolean; edgeWidth?:number; edgeHandle?:RefObject<HTMLElement|null>;
}) {
  const reducedMotion = useMotionReduction();
  const progress = useMotionValue(enabled && open ? 1 : 0);
  const [present, setPresent] = useState(enabled && open);
  const [dragging, setDragging] = useState(false);
  const latest = useRef({ open, onOpenChange, reducedMotion, intent, onInteractionStart });
  latest.current = { open, onOpenChange, reducedMotion, intent, onInteractionStart };
  const gesture = useRef<Gesture | null>(null);
  const generation = useRef(0);
  const target = useRef<boolean | null>(null);
  const context = useRef({ intent, scopeKey });
  const suppressClick = useRef(false);
  const returnRequested = useRef(false);
  const settle = (next: boolean) => {
    const receipt = ++generation.current;
    progress.stop();
    target.current = next;
    if (next) setPresent(true);
    const finish = () => { if (generation.current !== receipt) return; if (!next) setPresent(false); };
    if (latest.current.reducedMotion) { progress.set(next ? 1 : 0); finish(); }
    else animate(progress, next ? 1 : 0, { ...(latest.current.intent === "back" ? PANEL_CONTINUOUS_SPRING_TRANSITION : { ...PANEL_SPRING_TRANSITION, bounce: 0 }), onComplete: finish });
  };
  const settleRef = useRef(settle);
  settleRef.current = settle;

  useLayoutEffect(() => {
    gesture.current = null;
    setDragging(false);
    if (context.current.intent !== intent || context.current.scopeKey !== scopeKey) {
      returnRequested.current = false;
      context.current = { intent, scopeKey }; ++generation.current; progress.stop();
      progress.set(open ? 1 : 0); target.current = open; setPresent(open); return;
    }
    if (!enabled) { ++generation.current; progress.stop(); progress.set(0); setPresent(false); target.current = null; }
    else if (target.current !== open || reducedMotion) settleRef.current(open);
  }, [enabled, open, reducedMotion, progress, intent, scopeKey]);

  useLayoutEffect(() => {
    if (!enabled) return;
    let scrolling: ReturnType<typeof animate> | null = null;
    let releaseContactTarget = () => {};
    const stopContentMotion = () => { scrolling?.stop(); scrolling = null; };
    const cancel = (immediate = false, retainPosition = false) => {
      releaseContactTarget();
      stopContentMotion();
      if (!gesture.current) {
        // A cancelled gesture still has a presentation spring. A replacement
        // contact can take over its visible position; accepted Router intents
        // are independently fenced by returnRequested.
        if (latest.current.intent === "back" && (progress.get() > 0 || target.current === true)) {
          ++generation.current; progress.stop(); target.current = null;
          if (!retainPosition) {
            if (immediate) { progress.set(0); target.current = false; setPresent(false); }
            else settleRef.current(false);
          }
        }
        return;
      }
      const { initiallyOpen: previous, owner } = gesture.current;
      if (owner === "sidebar" || owner === "content") suppressClick.current = true;
      gesture.current = null; setDragging(false);
      if (owner !== "sidebar") {
        if (!retainPosition && latest.current.intent === "back" && progress.get() > 0) {
          if (immediate) {
            ++generation.current; progress.stop(); target.current = false;
            progress.set(0); setPresent(false);
          } else settleRef.current(false);
        }
        return;
      }
      if (retainPosition && latest.current.intent === "back") {
        ++generation.current; progress.stop(); target.current = null;
      } else if (immediate) {
        ++generation.current; progress.stop(); target.current = previous;
        progress.set(previous ? 1 : 0); setPresent(previous);
      } else settleRef.current(previous);
    };
    const foregroundOwnsInput = (event?: Event) => {
      const shell = root.current;
      if (!shell || !hasForegroundInputOwner(shell, event?.composedPath(), withinModal, overlay.current)) return false;
      cancel(true);
      // Native showModal may dispatch touchcancel before its open mutation is
      // observed. Revoke that already-settling background animation as well.
      if (target.current !== null) {
        ++generation.current; progress.stop();
        progress.set(target.current ? 1 : 0); setPresent(target.current);
      }
      // The next physical contact releases click suppression; an asynchronous
      // foreground change must not turn the retired drag into a click.
      return true;
    };
    const start = (event: ContactEvent) => {
      // A released return is an accepted Router intent, not a cancellable animation.
      // Browser POP may commit asynchronously; do not let another contact re-own it.
      if (returnRequested.current) return;
      // A host can lose the old end/cancel on interruption. Retire its writer
      // before admitting any new contact, including editor/native-only taps.
      cancel(true, latest.current.intent === "back");
      stopContentMotion();
      // A fresh deliberate tap must remain usable immediately after a swipe.
      suppressClick.current = false;
      if (contacts(event).length !== 1) { cancel(); return; }
      const shell = root.current, surface = overlay.current;
      if (!shell) { cancel(); return; }
      const path = event.composedPath();
      const page = foreground?.current;
      const boundary = surface && path.includes(surface) ? surface : page && path.includes(page) ? page : path.includes(shell) ? shell : null;
      if (!boundary || foregroundOwnsInput(event) || window.getSelection()?.toString()) { cancel(); return; }
      const scrollports = horizontalInput(path, boundary);
      if (scrollports === "exclusive") { cancel(); return; }
      const horizontal = scrollports[0] ?? null;
      // Clickable content (reasoning disclosures, image previews, links) can
      // also start a swipe. Axis locking preserves taps/vertical scrolling;
      // the recognized drag suppresses its click in end/cancel below.
      const touch = contacts(event)[0]!;
      const viewport = shell.getBoundingClientRect();
      // Host adapters may hand their reserved contact to this existing owner.
      // Unclaimed screen edges remain native; no host detection belongs here.
      if(!latest.current.open) {
        if(leftEdgeOnly&&touch.clientX>viewport.left+edgeWidth)return;
        if(excludeLeftEdge&&touch.clientX<=viewport.left+edgeWidth)return;
      }
      const inside = touch.clientX >= viewport.left && touch.clientX <= viewport.right;
      let sidebarAllowed = inside && ((edgeHandle?.current && path.includes(edgeHandle.current)) || readEdgeGestureHandoff(event) !== undefined
        || (touch.clientX >= viewport.left + MOBILE_SIDEBAR_EDGE_RESERVE && touch.clientX <= viewport.right - MOBILE_SIDEBAR_EDGE_RESERVE));
      if (!sidebarAllowed && !horizontal) { cancel(); return; }
      if (sidebarAllowed && latest.current.intent === "back" && presentation?.current) {
        const position = presentation.current.acquire();
        if (position === null) sidebarAllowed = false;
        else {
          ++generation.current; target.current = null;
          progress.jump(position); setPresent(position > 0);
        }
      }
      gesture.current = { initialFocus:document.activeElement instanceof HTMLElement?document.activeElement:null, id: touch.identifier, x: touch.clientX, y: touch.clientY, width: width.get(), start: progress.get(), initiallyOpen: latest.current.open, owner: "pending", sidebarAllowed, horizontal, scrollports, motionStartedAt: null, samples: [{ x: touch.clientX, time: event.timeStamp }], nativeReader: path.some(node => node instanceof Element && node.getAttribute('data-sidebar-gesture') === 'vertical-pan') };
      // Native contacts keep their original target even if a live reader
      // redraws that node. Continue the same transaction when its event path
      // no longer reaches document; connected paths still have exactly one owner.
      const contactTarget = path[0];
      if (contactTarget instanceof Element) {
        const forward = (event: Event) => {
          if (event.composedPath().includes(document)) return;
          if (event.type === 'touchmove') move(event as TouchEvent);
          else if (event.type === 'touchend') end(event as TouchEvent);
          else cancel();
        };
        for (const type of ['touchmove','touchend','touchcancel']) contactTarget.addEventListener(type, forward, { capture: true, passive: false });
        releaseContactTarget = () => {
          for (const type of ['touchmove','touchend','touchcancel']) contactTarget.removeEventListener(type, forward, true);
          releaseContactTarget = () => {};
        };
      }
    };
    const move = (event: ContactEvent) => {
      const transaction = gesture.current;
      if (!transaction) return;
      if (foregroundOwnsInput(event)) return;
      if (contacts(event).length !== 1) { cancel(); return; }
      if (window.getSelection()?.toString()) { cancel(); return; }
      const touch = contacts(event).find(t => t.identifier === transaction.id);
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
        sidebarAllowed: transaction.sidebarAllowed, initiallyOpen: transaction.initiallyOpen || (latest.current.intent === "back" && transaction.start > 0),
        horizontalContent: horizontal !== null,
        contentCanScroll: horizontal !== null && (dx > 0 ? horizontal.start > horizontal.min + 1 : horizontal.start < horizontal.max - 1),
      });
      if (owner === "native") {
        if (sidebarGestureAxis(dx, dy) !== "pending") suppressClick.current = true;
        cancel(); return;
      }
      if (owner === "pending") {
        // Reserve a recognized horizontal contact while deciding its writer.
        // Cancel the first direction-locked move, before native panning starts.
        // No component marker or ancestor touch-action restriction is required.
        if (horizontal && sidebarGestureAxis(dx, dy) === "horizontal" && event.cancelable) event.preventDefault();
        return;
      }
      if (event.cancelable) event.preventDefault();
      if (owner === "content" && horizontal) {
        if (transaction.owner !== "content" && latest.current.intent === "back" && progress.get() > 0) settleRef.current(false);
        transaction.owner = owner;
        horizontal.element.scrollLeft = Math.max(horizontal.min, Math.min(horizontal.max, horizontal.start - dx));
        return;
      }
      // Once Shell owns the contact, a native reader below it must not also
      // scroll or consume this move. Vertical/unclaimed contacts still pass.
      if (transaction.nativeReader) event.stopPropagation();
      if (transaction.owner !== "sidebar") {
        // During native scroll inertia a fresh horizontal sequence can already
        // be non-cancelable. It still owns drawer movement; only prevent the
        // browser default when supported, after the vertical/input exclusions.
        // Stop the old animation before reading its current position.
        progress.stop(); ++generation.current; target.current = null;
        transaction.start = progress.get(); transaction.owner = "sidebar";
        latest.current.onInteractionStart?.(transaction.initialFocus??null);
        setPresent(true); setDragging(true);
      }
      progress.set(sidebarGestureProgress(transaction.start, dx, transaction.width));
    };
    const end = (event: ContactEvent) => {
      const transaction = gesture.current;
      if (!transaction || !contacts(event, true).some(t => t.identifier === transaction.id)) return;
      releaseContactTarget();
      if (foregroundOwnsInput(event)) return;
      gesture.current = null; setDragging(false);
      let releaseProgress = progress.get();
      if (transaction.owner === "pending") {
        const touch = contacts(event, true).find(t => t.identifier === transaction.id)!;
        const dx = touch.clientX - transaction.x, dy = touch.clientY - transaction.y;
        const horizontal = transaction.scrollports.find(port =>
          dx > 0 ? port.start > port.min + 1 : port.start < port.max - 1) ?? transaction.scrollports[0] ?? null;
        transaction.horizontal = horizontal;
        transaction.owner = arbitrateMobileGesture({
          owner: "pending", dx, dy, elapsed: 0, velocity: null, ended: true,
          sidebarAllowed: transaction.sidebarAllowed, initiallyOpen: transaction.initiallyOpen || (latest.current.intent === "back" && transaction.start > 0),
          horizontalContent: horizontal !== null,
          contentCanScroll: horizontal !== null && (dx > 0 ? horizontal.start > horizontal.min + 1 : horizontal.start < horizontal.max - 1),
        });
        const axis = sidebarGestureAxis(dx, dy);
        if (axis !== "pending") suppressClick.current = true;
        // A one-sample contact finishes as local reading instead of disappearing.
        if (transaction.owner === "content" && horizontal?.element.isConnected) {
          horizontal.element.scrollLeft = Math.max(horizontal.min, Math.min(horizontal.max, horizontal.start - dx));
          if (event.cancelable) event.preventDefault();
          suppressClick.current = true;
        }
        if (transaction.owner !== "sidebar") {
          if (latest.current.intent === "back" && progress.get() > 0) settleRef.current(false);
          return;
        }
        // WebKit can coalesce all movement into changedTouches at touchend.
        // Recognize that drag without jumping the presentation to an unseen offset.
        // The existing spring travels from the current value to its release target.
        releaseProgress = sidebarGestureProgress(transaction.start, dx, transaction.width);
      }
      if (event.cancelable) event.preventDefault();
      suppressClick.current = true;
      const touch = contacts(event, true).find(t => t.identifier === transaction.id)!;
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
      const next = sidebarGestureTarget(releaseProgress, sidebarReleaseVelocity(transaction.samples, touch.clientX, event.timeStamp) * MOBILE_SIDEBAR_REVEAL_DIRECTION, touch.clientX - transaction.x, transaction.initiallyOpen);
      if (latest.current.intent === "back") {
        if (!next) settleRef.current(false);
        else {
          ++generation.current; progress.stop(); target.current = null;
          returnRequested.current = true;
          if (latest.current.onOpenChange(true) === false) {
            returnRequested.current = false; settleRef.current(false);
          }
          // Router now owns the return. StackSurface captures this exact position
          // and settles the departing pixels after the active page has changed.
        }
      } else {
        settleRef.current(next);
        if (next !== latest.current.open) latest.current.onOpenChange(next);
      }
    };
    // Compatibility clicks belong to their physical contact, not a 500ms timer.
    // A new touch/pen/mouse contact admits a deliberate click; keyboard activation
    // (detail=0) stays usable without retiring the previous drag's click fence.
    const newContact = () => { suppressClick.current = false; };
    const click = (event: MouseEvent) => {
      if (!suppressClick.current || (event.detail === 0 && !("pointerType" in event && event.pointerType === "touch"))) return;
      suppressClick.current = false; event.preventDefault(); event.stopImmediatePropagation();
    };
    // The preview adapter is optional and shares this exact gesture transaction.
    let mouseDisposed = false;
    let disposeMouse: (() => void) | undefined;
    if (emulateMouse) void import("./preview-mouse-gesture").then(({bindPreviewMouseGesture}) => {
      if (!mouseDisposed) disposeMouse = bindPreviewMouseGesture({root, gesture, start, move, end, cancel});
    });
    document.addEventListener("pointerdown", newContact, true);
    document.addEventListener("touchstart", start, { passive: true, capture: true });
    document.addEventListener("touchmove", move, { passive: false, capture: true });
    document.addEventListener("touchend", end, { passive: false, capture: true });
    const cancelContact = () => cancel();
    // Backgrounded WebViews may suspend animation frames and omit touchend.
    // Restore the committed intent synchronously before yielding to the host.
    const interruptContact = () => cancel(true);
    const visibilityChanged = () => { if (document.visibilityState !== "visible") interruptContact(); };
    document.addEventListener("touchcancel", cancelContact, true);
    document.addEventListener("click", click, true);
    window.addEventListener("resize", cancelContact);
    window.addEventListener("blur", interruptContact);
    window.addEventListener("pagehide", interruptContact);
    document.addEventListener("visibilitychange", visibilityChanged);
    // A modal appearing while the finger is held revokes the old gesture now,
    // rather than letting its later move/end write behind the foreground view.
    const foregroundObserver = new MutationObserver(() => { if (gesture.current || scrolling || (progress.get() > 0 && progress.get() < 1)) foregroundOwnsInput(); });
    const scope = root.current?.getRootNode();
    const observation = { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "aria-modal", "role", "hidden", "aria-hidden"] };
    if (scope) foregroundObserver.observe(scope, observation);
    if (scope !== document) foregroundObserver.observe(document, observation);
    return () => {
      mouseDisposed = true;
      disposeMouse?.();
      releaseContactTarget();
      stopContentMotion();
      foregroundObserver.disconnect();
      document.removeEventListener("pointerdown", newContact, true);
      document.removeEventListener("touchstart", start, true); document.removeEventListener("touchmove", move, true);
      document.removeEventListener("touchend", end, true); document.removeEventListener("touchcancel", cancelContact, true);
      document.removeEventListener("click", click, true); window.removeEventListener("resize", cancelContact);
      window.removeEventListener("blur", interruptContact);
      window.removeEventListener("pagehide", interruptContact);
      document.removeEventListener("visibilitychange", visibilityChanged);
      gesture.current = null;
    };
  }, [enabled, emulateMouse, withinModal, overlay, foreground, root, progress, width, intent, scopeKey, presentation,leftEdgeOnly,excludeLeftEdge,edgeWidth,edgeHandle]);
  useLayoutEffect(()=>{
    const handle=edgeHandle?.current;if(!enabled||!handle)return;
    let contact:{pointerId:number;x:number;start:number;open:boolean;moving:boolean;samples:GestureSample[];initialFocus:HTMLElement|null}|null=null;
    const end=(cancel=false,event?:PointerEvent)=>{
      const current=contact;if(!current)return;contact=null;setDragging(false);
      if(current.moving)suppressClick.current=true;
      const next=cancel||!current.moving?current.open:sidebarGestureTarget(progress.get(),sidebarReleaseVelocity(current.samples,event?.clientX??current.x,event?.timeStamp??performance.now()),(event?.clientX??current.x)-current.x,current.open);
      settleRef.current(next);
      if(!cancel&&current.moving&&next!==latest.current.open)latest.current.onOpenChange(next);
    };
    const down=(event:PointerEvent)=>{
      if(event.pointerType==='touch'||!event.isPrimary||event.button!==0)return;
      if(contact)end(true);
      ++generation.current;progress.stop();
      contact={initialFocus:document.activeElement instanceof HTMLElement?document.activeElement:null,pointerId:event.pointerId,x:event.clientX,start:progress.get(),open:latest.current.open,moving:false,samples:[{x:event.clientX,time:event.timeStamp}]};
      suppressClick.current=false;handle.setPointerCapture(event.pointerId);
    };
    const move=(event:PointerEvent)=>{
      if(!contact||event.pointerId!==contact.pointerId)return;
      const dx=event.clientX-contact.x;
      if(!contact.moving&&Math.abs(dx)<MOBILE_GESTURE_DEADZONE)return;
      if(!contact.moving)latest.current.onInteractionStart?.(contact.initialFocus);
      contact.moving=true;setDragging(true);setPresent(true);
      contact.samples.push({x:event.clientX,time:event.timeStamp});
      while(contact.samples.length>2&&contact.samples[1]!.time<event.timeStamp-100)contact.samples.shift();
      progress.set(Math.max(0,Math.min(1,contact.start+dx/Math.max(1,width.get()))));
      event.preventDefault();
    };
    const up=(event:PointerEvent)=>{if(contact&&event.pointerId===contact.pointerId)end(false,event);};
    const cancel=()=>end(true);
    handle.addEventListener('pointerdown',down);handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',up);
    handle.addEventListener('pointercancel',cancel);handle.addEventListener('lostpointercapture',cancel);
    window.addEventListener('blur',cancel);window.addEventListener('resize',cancel);
    return()=>{contact=null;handle.removeEventListener('pointerdown',down);handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',up);handle.removeEventListener('pointercancel',cancel);handle.removeEventListener('lostpointercapture',cancel);window.removeEventListener('blur',cancel);window.removeEventListener('resize',cancel);};
  },[enabled,edgeHandle,progress,width]);
  useLayoutEffect(() => () => { ++generation.current; progress.stop(); }, [progress]);
  return { progress, present, dragging };
}
