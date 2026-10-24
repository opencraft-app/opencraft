import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import "./liquid-glass.web.scss";

/** Geometry is static between resizes. SourceGraphic is the live compositor
 * backdrop, so transmission and local contrast respond to every content frame. */
export function LiquidGlassBackdrop() {
  const id = `liquid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const ref = useRef<HTMLSpanElement>(null);
  const [map, setMap] = useState<{ href: string; width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    // Prefixed backdrop engines can accept URL syntax without rendering it.
    // Keep their working CSS blur instead of replacing it with an inert lens.
    if (!element || !CSS.supports("backdrop-filter", 'url("#lens")')
      || CSS.supports("-webkit-backdrop-filter", "blur(1px)")) return;
    const observer = new ResizeObserver(() => {
      const width = Math.round(element.clientWidth), height = Math.round(element.clientHeight);
      if (width < 1 || height < 1) return;
      // One CSS-pixel lookup per surface pixel, not a captured page texture.
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return;
      const pixels = context.createImageData(width, height);
      const radius = height / 2, halfLine = Math.max(0, width / 2 - radius);
      const bevel = Math.min(12, radius * .55), thickness = bevel * .8, eta = 1 / 1.46;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const dx = x + .5 - Math.max(width / 2 - halfLine, Math.min(width / 2 + halfLine, x + .5));
        const dy = y + .5 - height / 2, distance = Math.hypot(dx, dy);
        const edge = Math.max(0, radius - distance);
        const t = Math.min(1, edge / bevel), cap = Math.sqrt(Math.max(.001, 1 - (1 - t) ** 2));
        // Elliptical shoulder -> unit normal -> Snell transmitted direction.
        // A flat central region keeps labels underneath recognizable.
        const slope = thickness / bevel * (1 - t) / cap;
        const nz = 1 / Math.hypot(1, slope), nr = slope * nz;
        const refracted = eta * nz - Math.sqrt(1 - eta * eta * (1 - nz * nz));
        const tz = -eta + refracted * nz;
        const offset = Math.max(-11, (thickness * cap + 6) * refracted * nr / -tz) * Math.min(1, edge);
        const fresnel = .04 + .96 * (1 - nz) ** 5;
        const i = (y * width + x) * 4;
        // R/G: signed ray offset for scale=24; B: clear curved shoulder mask.
        pixels.data[i] = Math.round(255 * (.5 + offset * dx / (distance || 1) / 24));
        pixels.data[i + 1] = Math.round(255 * (.5 + offset * dy / (distance || 1) / 24));
        pixels.data[i + 2] = Math.round(255 * Math.min(1, (1 - t) ** 2 + fresnel));
        pixels.data[i + 3] = 255;
      }
      context.putImageData(pixels, 0, 0);
      setMap({ href: canvas.toDataURL(), width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <span ref={ref} aria-hidden="true" className="ui-liquid-glass"
    style={map ? { "--material-liquid-lens": `url("#${id}") saturate(1.15)` } as CSSProperties : undefined}>
    {map ? <svg className="ui-liquid-glass__filters" width="0" height="0" focusable="false">
      <defs><filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feImage href={map.href} width={map.width} height={map.height} result="lens-map" preserveAspectRatio="none" />
        <feGaussianBlur in="SourceGraphic" stdDeviation=".45" result="antialiased" />
        <feDisplacementMap in="antialiased" in2="lens-map" scale="24" xChannelSelector="R" yChannelSelector="G" result="transmission" />
        <feGaussianBlur in="transmission" stdDeviation="2.2" result="scattered" />
        <feColorMatrix in="lens-map" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 -1 0 1" result="center" />
        <feComposite in="scattered" in2="center" operator="in" result="soft-center" />
        <feComposite in="transmission" in2="center" operator="out" result="clear-edge" />
        <feComposite in="soft-center" in2="clear-edge" operator="arithmetic" k2="1" k3="1" result="glass" />
        {/* Local detail energy controls a theme-colored veil. Empty backgrounds
            remain clear; moving dense text receives more contrast protection. */}
        <feColorMatrix in="transmission" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  .2126 .7152 .0722 0 0" result="luminance" />
        <feColorMatrix in="scattered" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  .2126 .7152 .0722 0 0" result="mean-luminance" />
        <feComposite in="luminance" in2="mean-luminance" operator="arithmetic" k2="1" k3="-1" result="detail-positive" />
        <feComposite in="mean-luminance" in2="luminance" operator="arithmetic" k2="1" k3="-1" result="detail-negative" />
        <feComposite in="detail-positive" in2="detail-negative" operator="arithmetic" k2="1" k3="1" result="detail" />
        <feColorMatrix in="detail" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 2 0" result="contrast" />
        <feGaussianBlur in="contrast" stdDeviation="2" result="local-contrast" />
        <feFlood style={{ floodColor: "var(--material-glass-base)" }} floodOpacity=".65" result="tint" />
        <feComposite in="tint" in2="local-contrast" operator="in" result="adaptive-tint" />
        <feComposite in="adaptive-tint" in2="glass" operator="over" />
      </filter></defs>
    </svg> : null}
  </span>;
}
