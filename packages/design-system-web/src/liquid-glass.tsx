import React, { useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/** Geometry is static between resizes. SourceGraphic is the live compositor
 * backdrop, so transmission and local contrast respond to every content frame. */
export function LiquidGlassBackdrop({ active = true, material = "glass", shape = "capsule" }: { active?: boolean; material?: "glass" | "solid"; shape?: "capsule" | "rounded-rectangle" }) {
  const id = `liquid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const ref = useRef<HTMLSpanElement>(null);
  const [map, setMap] = useState<{ href: string; width: number; height: number; blur: number; filter: React.ReactNode } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    // Prefixed backdrop engines can accept URL syntax without rendering it.
    // Keep their working CSS blur instead of replacing it with an inert lens.
    if (!active || material === "solid" || !element || !CSS.supports("backdrop-filter", 'url("#lens")')
      || CSS.supports("-webkit-backdrop-filter", "blur(1px)")) return;
    let disposed = false;
    let observer: ResizeObserver | undefined;
    void import("./liquid-glass-map").then(({ createLiquidGlassMap, renderLiquidGlassFilter }) => {
      if (disposed) return;
      observer = new ResizeObserver(() => {
        const width = Math.round(element.clientWidth), height = Math.round(element.clientHeight);
        if (width < 1 || height < 1) return;
        // CSS and SVG share one scattering length. The optical graph includes
        // its full blur kernel so transparent filter edges cannot reveal detail.
        const blur = Number.parseFloat(getComputedStyle(element).getPropertyValue("--material-liquid-blur"));
        if (!Number.isFinite(blur) || blur < 0) return;
        const next = createLiquidGlassMap(element, width, height, blur, shape);
        if (next) setMap({ ...next, filter: renderLiquidGlassFilter(id, next) });
      });
      observer.observe(element);
    }).catch(() => { /* CSS blur remains the working fallback if the optical chunk cannot load. */ });
    return () => { disposed = true; observer?.disconnect(); };
  }, [active, material, shape, id]);
  return <span ref={ref} aria-hidden="true" className="ui-liquid-glass"
    data-material={material} data-shape={shape}
    style={material === "glass" && map ? { "--material-liquid-lens": `url("#${id}") saturate(1.15)` } as CSSProperties : undefined}>
    {material === "glass" && map ? map.filter : null}
  </span>;
}
