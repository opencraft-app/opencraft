import { useEffect, type RefObject } from "react";

export interface DismissableLayerOptions {
  enabled: boolean;
  refs: Array<RefObject<HTMLElement | null>>;
  onDismiss: () => void;
}

export function useDismissableLayer({
  enabled,
  refs,
  onDismiss,
}: DismissableLayerOptions) {
  useEffect(() => {
    if (!enabled) return;

    const isInsideLayer = (target: EventTarget | null) =>
      target instanceof Node &&
      refs.some((ref) => ref.current?.contains(target) ?? false);

    const onPointerDown = (event: PointerEvent) => {
      if (!isInsideLayer(event.target)) onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [enabled, onDismiss, refs]);
}

