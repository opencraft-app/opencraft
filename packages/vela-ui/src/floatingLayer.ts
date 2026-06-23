import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

export type FloatingLayerPlacement = "bottom-start" | "bottom-end" | "top-start";

export interface FloatingLayerOptions {
  anchorRef: RefObject<HTMLElement | null>;
  boundaryPadding?: number;
  enabled: boolean;
  estimatedSize?: {
    width: number;
    height?: number;
  };
  offset?: number;
  placement?: FloatingLayerPlacement;
}

export function useFloatingLayer({
  anchorRef,
  boundaryPadding = 12,
  enabled,
  estimatedSize,
  offset = 8,
  placement = "bottom-start",
}: FloatingLayerOptions): CSSProperties | null {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const estimatedWidth = estimatedSize?.width;

  useLayoutEffect(() => {
    if (!enabled || typeof window === "undefined") {
      setStyle(null);
      return;
    }

    const updatePosition = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const width = estimatedWidth ?? rect.width;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const minLeft = boundaryPadding;
      const maxLeft = Math.max(minLeft, viewportWidth - boundaryPadding - width);
      const nextStyle: CSSProperties = {
        maxHeight: `${Math.max(120, viewportHeight - boundaryPadding * 2)}px`,
        maxWidth: `${Math.max(160, viewportWidth - boundaryPadding * 2)}px`,
        position: "fixed",
      };
      const clampLeft = (left: number) => Math.min(Math.max(left, minLeft), maxLeft);

      if (placement === "top-start") {
        nextStyle.bottom = `${window.innerHeight - rect.top + offset}px`;
        nextStyle.left = `${clampLeft(rect.left)}px`;
      } else {
        nextStyle.top = `${rect.bottom + offset}px`;
        if (placement === "bottom-end") {
          nextStyle.left = `${clampLeft(rect.right - width)}px`;
        } else {
          nextStyle.left = `${clampLeft(rect.left)}px`;
        }
      }

      setStyle(nextStyle);
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [
    anchorRef,
    boundaryPadding,
    enabled,
    estimatedWidth,
    offset,
    placement,
  ]);

  return style;
}
