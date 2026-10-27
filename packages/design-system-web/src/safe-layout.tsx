import { createElement, forwardRef, type CSSProperties, type HTMLAttributes } from "react";

export type SafeLayoutEdge = "top" | "right" | "bottom" | "left";
export type SafeLayoutInsets = Partial<Record<SafeLayoutEdge, string | number>>;

export interface SafeLayoutProps extends HTMLAttributes<HTMLElement> {
  /** Explicit allocation: an edge already consumed by an ancestor is omitted. */
  readonly edges: readonly SafeLayoutEdge[];
  readonly as?: "div" | "aside";
  /** Ordinary content spacing is a minimum, not an additional device inset. */
  readonly minimumInsets?: SafeLayoutInsets;
}

const paddingProperties = { top: "paddingTop", right: "paddingRight", bottom: "paddingBottom", left: "paddingLeft" } as const;
const cssLength = (value: string | number) => typeof value === "number" ? `${value}px` : value;

/** Full-bleed surface with safe content. Padding stays inside the painted border
 * box: no outer offset, wrapper, observer, theme state or viewport measurement.
 * The host may project CSS insets; otherwise the browser's env() owns them. */
export const SafeLayout = forwardRef<HTMLElement, SafeLayoutProps>(function SafeLayout(
  { as: Element = "div", edges, minimumInsets, style, ...props }, ref,
) {
  const layoutStyle: CSSProperties = { ...style, boxSizing: "border-box" };
  for (const edge of edges) {
    const inset = `var(--safe-layout-inset-${edge}, env(safe-area-inset-${edge}, 0px))`;
    const minimum = minimumInsets?.[edge];
    layoutStyle[paddingProperties[edge]] = minimum === undefined ? inset : `max(${cssLength(minimum)}, ${inset})`;
  }
  return createElement(Element, { ...props, ref, "data-safe-layout": edges.join(" "), style: layoutStyle });
});
