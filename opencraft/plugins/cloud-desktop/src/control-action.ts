import { useEffect, useRef, type RefObject, type MouseEvent, type PointerEvent, type KeyboardEvent } from "react";
import type { DesktopViewController } from "./controller";

type Press = { source: "pointer"; id: number; target: HTMLButtonElement; run: () => void }
  | { source: "keyboard"; key: string; target: HTMLButtonElement; run: () => void };
const cancelled = () => {};

/** Presentation owns the native activation sequence. It captures intent before
 * focus changes, but still commits on click (including keyboard/AT activation).
 * No synthesized pointerup clicks, time windows or delayed input revocation. */
export function useDesktopControlAction(controller: RefObject<DesktopViewController | null>,
  action: "take" | "stop") {
  const press = useRef<Press | null>(null);
  const prepare = () => controller.current?.prepareControlAction(action) ?? cancelled;
  useEffect(() => {
    const cancel = () => { if (press.current) press.current.run = cancelled; };
    const visibility = () => { if (document.visibilityState !== "visible") cancel(); };
    const pointerUp = (event: globalThis.PointerEvent) => {
      const current = press.current;
      if (current?.source === "pointer" && current.id === event.pointerId
        && (!(event.target instanceof Node) || !current.target.contains(event.target))) cancel();
    };
    const pointerCancel = (event: globalThis.PointerEvent) => {
      if (press.current?.source === "pointer" && press.current.id === event.pointerId) cancel();
    };
    const keyUp = (event: globalThis.KeyboardEvent) => {
      const current = press.current;
      if (current?.source === "keyboard" && current.key === event.key
        && (!(event.target instanceof Node) || !current.target.contains(event.target))) cancel();
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
    onPointerDownCapture(event: PointerEvent<HTMLButtonElement>) {
      if (event.button !== 0 || !event.isPrimary) return;
      press.current = { source: "pointer", id: event.pointerId, target: event.currentTarget, run: prepare() };
    },
    onKeyDownCapture(event: KeyboardEvent<HTMLButtonElement>) {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (event.repeat) { event.preventDefault(); return; }
      press.current = { source: "keyboard", key: event.key, target: event.currentTarget, run: prepare() };
    },
    onClick(event: MouseEvent<HTMLButtonElement>) {
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
