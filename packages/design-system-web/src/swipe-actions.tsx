import { animate, motion, useMotionValue } from "motion/react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useMotionReduction } from "./use-motion-reduction";

export interface SwipeAction { readonly label: string; readonly icon?: ReactNode; readonly onInvoke: () => void }
interface Contact { pointerId: number; x: number; y: number; width: number; axis: "pending" | "horizontal" }
const commitDistance = (width: number) => Math.min(112, Math.max(64, width * 0.3));
const settleMotion = { type: "spring", stiffness: 500, damping: 42, mass: 0.65 } as const;

/** Horizontal row actions. Consumers supply matching keyboard/menu actions and own persistence. */
export function SwipeActions({ children, left, right, disabled = false }: {
  readonly children: ReactNode; readonly left: SwipeAction; readonly right: SwipeAction; readonly disabled?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null), contact = useRef<Contact | null>(null);
  const x = useMotionValue(0), reduced = useMotionReduction();
  const [preview, setPreview] = useState<{ side: "left" | "right"; armed: boolean } | null>(null);
  const suppressClick = useRef(false), latest = useRef({ left, right, disabled, reduced });
  const generation = useRef(0);
  const wheelEnd = useRef<ReturnType<typeof setTimeout> | null>(null);
  latest.current = { left, right, disabled, reduced };
  const reset = (immediate = false) => {
    const receipt = ++generation.current;
    if (wheelEnd.current !== null) { clearTimeout(wheelEnd.current); wheelEnd.current = null; }
    const held = contact.current; contact.current = null; x.stop();
    if (held && root.current?.hasPointerCapture(held.pointerId)) root.current.releasePointerCapture(held.pointerId);
    if (immediate || latest.current.reduced) { x.jump(0); setPreview(null); }
    else animate(x, 0, { ...settleMotion,
      onComplete: () => { if (generation.current === receipt) setPreview(null); } });
  };
  const resetRef = useRef(reset); resetRef.current = reset;
  useLayoutEffect(() => {
    if (disabled) resetRef.current();
    else if (reduced && !contact.current) resetRef.current(true);
  }, [disabled, reduced]);
  useLayoutEffect(() => {
    resetRef.current(true);
    const cancel = () => resetRef.current(true);
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") resetRef.current(); };
    const otherPointer = (event: PointerEvent) => { if (wheelEnd.current !== null || contact.current && event.pointerId !== contact.current.pointerId) cancel(); };
    const foreground = (event: FocusEvent) => { if ((contact.current || wheelEnd.current !== null) && event.target instanceof Element && event.target.closest('[role="dialog"],[role="menu"],[role="listbox"]')) cancel(); };
    const element = root.current!;
    const wheel = (event: WheelEvent) => {
      if (wheelEnd.current !== null && Math.abs(event.deltaY) > Math.abs(event.deltaX) * 1.35) resetRef.current();
      if (event.ctrlKey || latest.current.disabled || contact.current || Math.abs(event.deltaX) < 1
        || Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.35
        || event.target instanceof Element && event.target.closest('[data-swipe-ignore],input,textarea,select,[contenteditable="true"],a')
        || element.closest('[inert],[hidden],[aria-hidden="true"]')) return;
      event.preventDefault();
      if (wheelEnd.current === null) { ++generation.current; x.stop(); x.set(0); }
      else clearTimeout(wheelEnd.current);
      const width = element.clientWidth;
      const distance = Math.max(-width * 0.65, Math.min(width * 0.65, x.get() - event.deltaX));
      x.set(distance); setPreview({ side: distance < 0 ? "left" : "right", armed: Math.abs(distance) >= commitDistance(width) });
      // Wheel has no terminal event. Idle closes one trackpad sequence including its momentum tail.
      wheelEnd.current = setTimeout(() => {
        wheelEnd.current = null; const distance = x.get();
        const commit = Math.abs(distance) >= commitDistance(width) && !latest.current.disabled
          && element.isConnected && !element.closest('[inert],[hidden],[aria-hidden="true"]');
        resetRef.current();
        if (commit) (distance < 0 ? latest.current.left : latest.current.right).onInvoke();
      }, 160);
    };
    window.addEventListener("blur", cancel); window.addEventListener("resize", cancel);
    document.addEventListener("visibilitychange", cancel); document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", otherPointer, true); document.addEventListener("focusin", foreground);
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      ++generation.current; contact.current = null; x.stop();
      if (wheelEnd.current !== null) clearTimeout(wheelEnd.current);
      window.removeEventListener("blur", cancel); window.removeEventListener("resize", cancel);
      document.removeEventListener("visibilitychange", cancel); document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", otherPointer, true); document.removeEventListener("focusin", foreground);
      element.removeEventListener("wheel", wheel);
    };
  }, [x]);
  return <motion.div ref={root} layout="position" transition={{ layout: reduced ? { duration: 0 } : { type: "spring", stiffness: 450, damping: 42 } }}
    className="ui-swipe-actions" data-preview={preview?.side} data-armed={preview?.armed || undefined}
    onPointerDownCapture={event => {
      suppressClick.current = false;
      if (!event.isPrimary) { reset(); return; }
      if (disabled || event.button !== 0 || !(event.target instanceof Element)
        || event.target.closest('[data-swipe-ignore],input,textarea,select,[contenteditable="true"],a,[role="menu"],[role="dialog"]')) return;
      ++generation.current; x.stop(); x.set(0); setPreview(null);
      contact.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: event.currentTarget.clientWidth, axis: "pending" };
    }}
    onPointerMove={event => {
      const held = contact.current;
      if (!held || held.pointerId !== event.pointerId) return;
      if (latest.current.disabled || event.currentTarget.closest('[inert],[hidden],[aria-hidden="true"]')) { reset(); return; }
      const dx = event.clientX - held.x, dy = event.clientY - held.y;
      if (held.axis === "pending") {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
        if (Math.abs(dy) >= Math.abs(dx) / 1.35) { reset(); return; }
        held.axis = "horizontal"; suppressClick.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
      x.set(Math.max(-held.width * 0.65, Math.min(held.width * 0.65, dx)));
      const side = dx < 0 ? "left" : "right", armed = Math.abs(dx) >= commitDistance(held.width);
      setPreview(previous => previous?.side === side && previous.armed === armed ? previous : { side, armed });
    }}
    onPointerUp={event => {
      const held = contact.current;
      if (!held || held.pointerId !== event.pointerId) return;
      const distance = x.get(), commit = held.axis === "horizontal" && Math.abs(distance) >= commitDistance(held.width) && !latest.current.disabled
        && !event.currentTarget.closest('[inert],[hidden],[aria-hidden="true"]');
      reset();
      if (commit) (distance < 0 ? latest.current.left : latest.current.right).onInvoke();
    }}
    onPointerCancel={() => reset()} onLostPointerCapture={event => { if (event.target === event.currentTarget && contact.current?.pointerId === event.pointerId) reset(); }}
    onClickCapture={event => { if (suppressClick.current && event.detail > 0) { event.preventDefault(); event.stopPropagation(); } suppressClick.current = false; }}
    onContextMenuCapture={() => reset()}>
    <div className="ui-swipe-actions__reveal" aria-hidden="true">{preview ? <>{preview.side === "left" ? left.icon : right.icon}<span>{preview.side === "left" ? left.label : right.label}</span></> : null}</div>
    <motion.div className="ui-swipe-actions__content" style={{ x }}>{children}</motion.div>
  </motion.div>;
}
