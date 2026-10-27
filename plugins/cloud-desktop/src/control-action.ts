import { useEffect, useRef, type RefObject, type MouseEvent, type PointerEvent, type KeyboardEvent } from "react";
import type { DesktopViewController } from "./controller";

type Press = { source: "pointer"; id: number; target: HTMLElement; run: () => void; managed: boolean; released: boolean; x: number; y: number }
  | { source: "keyboard"; key: string; target: HTMLElement; run: () => void };
const cancelled = () => {};

/** Presentation owns the native activation sequence. It captures intent before
 * focus changes. Toolbar/keyboard/AT commit on click; managed media mouse/pen clicks and touch taps
 * commit the fixed command on release, without synthesizing a click.
 * No time windows or delayed input revocation. */
export function useDesktopControlAction<T extends HTMLElement = HTMLButtonElement>(controller: RefObject<DesktopViewController | null>,
  action: "take" | "stop", managedSurfaceActivation = false) {
  const press = useRef<Press | null>(null);
  const prepare = () => controller.current?.prepareControlAction(action) ?? cancelled;
  useEffect(() => {
    const cancel = () => { if (press.current) press.current.run = cancelled; };
    const visibility = () => { if (document.visibilityState !== "visible") cancel(); };
    const releasedInside = (event: Event, target: HTMLElement) => event.composedPath().includes(target)
      || event.target instanceof Node && target.contains(event.target);
    const pointerUp = (event: globalThis.PointerEvent) => {
      const current = press.current;
      if (current?.source === "pointer" && current.id === event.pointerId
        && !releasedInside(event, current.target)) cancel();
    };
    const pointerCancel = (event: globalThis.PointerEvent) => {
      if (press.current?.source === "pointer" && press.current.id === event.pointerId) cancel();
    };
    const keyUp = (event: globalThis.KeyboardEvent) => {
      const current = press.current;
      if (current?.source === "keyboard" && current.key === event.key
        && !releasedInside(event, current.target)) cancel();
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("pointerup", pointerUp, true);
    document.addEventListener("pointercancel", pointerCancel, true);
    document.addEventListener("keyup", keyUp, true);
    return () => {
      press.current = null;
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("pointerup", pointerUp, true);
      document.removeEventListener("pointercancel", pointerCancel, true);
      document.removeEventListener("keyup", keyUp, true);
    };
  }, [controller]);
  return {
    onPointerDownCapture(event: PointerEvent<T>) {
      // noVNC can suppress native clicks on its canvas. Commit a managed
      // mouse/pen click or single-finger tap on release, without a synthetic click.
      if (managedSurfaceActivation && event.pointerType === "touch" && !event.isPrimary) {
        if (press.current) press.current.run = cancelled;
        return;
      }
      if (event.button !== 0 || !event.isPrimary) return;
      press.current = { source: "pointer", id: event.pointerId, target: event.currentTarget, run: prepare(),
        managed: managedSurfaceActivation, released: false, x: event.clientX, y: event.clientY };
    },
    onPointerMoveCapture(event: PointerEvent<T>) {
      const current = press.current;
      if (current?.source === "pointer" && current.managed && current.id === event.pointerId
        && Math.hypot(event.clientX - current.x, event.clientY - current.y) >= 8) current.run = cancelled;
    },
    onPointerUpCapture(event: PointerEvent<T>) {
      const current = press.current;
      if (current?.source !== "pointer" || current.id !== event.pointerId) return;
      current.released = true;
      if (!current.managed) return;
      const run = current.run; current.run = cancelled;
      // Keep the spent command until any compatibility click consumes it.
      if (event.currentTarget.contains(event.target as Node)
        && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 8) run();
    },
    onLostPointerCapture(event: PointerEvent<T>) {
      // Touch's implicit capture ends after pointerup, before the native click.
      // Only losing capture while still pressed cancels that activation.
      if (press.current?.source === "pointer" && press.current.id === event.pointerId
        && !press.current.released) press.current.run = cancelled;
    },
    onKeyDownCapture(event: KeyboardEvent<T>) {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (event.repeat) { event.preventDefault(); return; }
      press.current = { source: "keyboard", key: event.key, target: event.currentTarget, run: prepare() };
    },
    onClick(event: MouseEvent<T>) {
      const current = press.current;
      // PointerEvent clicks can carry detail=0; auxiliary/AT clicks without a
      // matching physical press remain independently accessible.
      const pointerId = (event.nativeEvent as globalThis.PointerEvent).pointerId;
      const matches = current?.target === event.currentTarget && (current.source === "keyboard"
        ? event.detail === 0 : event.detail > 0 || pointerId === current.id);
      const run = matches ? current!.run : prepare();
      press.current = null; // Consume before callbacks/focus can re-enter.
      run();
    },
  };
}
