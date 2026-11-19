import React from "react";

/** Build the shared optical displacement map only on engines supporting SVG backdrops. */
export function createLiquidGlassMap(
  element: HTMLElement,
  width: number,
  height: number,
  blur: number,
  shape: "capsule" | "rounded-rectangle",
) {
  // One CSS-pixel lookup per surface pixel, not a captured page texture.
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return;
  const pixels = context.createImageData(width, height);
  const style = getComputedStyle(element);
  const corners = [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomRightRadius,
    style.borderBottomLeftRadius,
  ].map((value) =>
    Math.min(
      width / 2,
      height / 2,
      value.endsWith("%") ? (Math.min(width, height) * parseFloat(value)) / 100 : parseFloat(value) || 0,
    ),
  );
  const radius = height / 2,
    halfLine = Math.max(0, width / 2 - radius);
  const bevel = Math.min(12, radius * 0.55),
    thickness = bevel * 0.8,
    eta = 1 / 1.46;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let dx = x + 0.5 - Math.max(width / 2 - halfLine, Math.min(width / 2 + halfLine, x + 0.5));
      let dy = y + 0.5 - height / 2,
        distance = Math.hypot(dx, dy);
      let edge = Math.max(0, radius - distance);
      if (shape === "rounded-rectangle") {
        // Panel lenses follow their real corners and flat edges, not the
        // circular/capsule field used by compact floating controls.
        const px = x + 0.5 - width / 2,
          py = y + 0.5 - height / 2;
        const r = corners[py < 0 ? (px < 0 ? 0 : 1) : px < 0 ? 3 : 2]!;
        const qx = Math.abs(px) - (width / 2 - r),
          qy = Math.abs(py) - (height / 2 - r);
        edge = Math.max(0, r - Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - Math.min(Math.max(qx, qy), 0));
        dx = qx > 0 && qy > 0 ? Math.sign(px) * qx : qx > qy ? Math.sign(px) : 0;
        dy = qx > 0 && qy > 0 ? Math.sign(py) * qy : qy >= qx ? Math.sign(py) : 0;
        distance = Math.hypot(dx, dy);
      }
      const t = Math.min(1, edge / bevel),
        cap = Math.sqrt(Math.max(0.001, 1 - (1 - t) ** 2));
      // Elliptical shoulder -> unit normal -> Snell transmitted direction.
      // A flat central region keeps labels underneath recognizable.
      const slope = ((thickness / bevel) * (1 - t)) / cap;
      const nz = 1 / Math.hypot(1, slope),
        nr = slope * nz;
      const refracted = eta * nz - Math.sqrt(1 - eta * eta * (1 - nz * nz));
      const tz = -eta + refracted * nz;
      const offset = Math.max(-11, ((thickness * cap + 6) * refracted * nr) / -tz) * Math.min(1, edge);
      const fresnel = 0.04 + 0.96 * (1 - nz) ** 5;
      const i = (y * width + x) * 4;
      // R/G: signed ray offset for scale=24; B: clear curved shoulder mask.
      pixels.data[i] = Math.round(255 * (0.5 + (offset * dx) / (distance || 1) / 24));
      pixels.data[i + 1] = Math.round(255 * (0.5 + (offset * dy) / (distance || 1) / 24));
      pixels.data[i + 2] = Math.round(255 * Math.min(1, (1 - t) ** 2 + fresnel));
      pixels.data[i + 3] = 255;
    }
  context.putImageData(pixels, 0, 0);
  return { href: canvas.toDataURL(), width, height, blur };
}

export function renderLiquidGlassFilter(
  id: string,
  map: { href: string; width: number; height: number; blur: number },
) {
  return (
    <svg className="ui-liquid-glass__filters" width="0" height="0" focusable="false">
      <defs>
        <filter
          id={id}
          filterUnits="userSpaceOnUse"
          primitiveUnits="userSpaceOnUse"
          x={-map.blur * 3}
          y={-map.blur * 3}
          width={map.width + map.blur * 6}
          height={map.height + map.blur * 6}
          colorInterpolationFilters="sRGB"
        >
          <feImage
            x="0"
            y="0"
            href={map.href}
            width={map.width}
            height={map.height}
            result="lens-map"
            preserveAspectRatio="none"
          />
          <feGaussianBlur in="SourceGraphic" stdDeviation=".45" result="antialiased" />
          <feDisplacementMap
            in="antialiased"
            in2="lens-map"
            scale="24"
            xChannelSelector="R"
            yChannelSelector="G"
            result="transmission"
          />
          <feGaussianBlur in="transmission" stdDeviation="2.2" result="scattered" />
          <feColorMatrix
            in="lens-map"
            type="matrix"
            values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 -1 0 1"
            result="center"
          />
          <feComposite in="scattered" in2="center" operator="in" result="soft-center" />
          <feComposite in="transmission" in2="center" operator="out" result="clear-edge" />
          <feComposite in="soft-center" in2="clear-edge" operator="arithmetic" k2="1" k3="1" result="glass" />
          {/* Local detail energy controls a theme-colored veil. Empty backgrounds
            remain clear; moving dense text receives more contrast protection. */}
          <feColorMatrix
            in="transmission"
            type="matrix"
            values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  .2126 .7152 .0722 0 0"
            result="luminance"
          />
          <feColorMatrix
            in="scattered"
            type="matrix"
            values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  .2126 .7152 .0722 0 0"
            result="mean-luminance"
          />
          <feComposite
            in="luminance"
            in2="mean-luminance"
            operator="arithmetic"
            k2="1"
            k3="-1"
            result="detail-positive"
          />
          <feComposite
            in="mean-luminance"
            in2="luminance"
            operator="arithmetic"
            k2="1"
            k3="-1"
            result="detail-negative"
          />
          <feComposite in="detail-positive" in2="detail-negative" operator="arithmetic" k2="1" k3="1" result="detail" />
          <feColorMatrix
            in="detail"
            type="matrix"
            values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 2 0"
            result="contrast"
          />
          <feGaussianBlur in="contrast" stdDeviation="2" result="local-contrast" />
          <feFlood style={{ floodColor: "var(--material-glass-base)" }} floodOpacity=".65" result="tint" />
          <feComposite in="tint" in2="local-contrast" operator="in" result="adaptive-tint" />
          <feComposite in="adaptive-tint" in2="glass" operator="over" result="tinted-glass" />
          <feGaussianBlur in="tinted-glass" stdDeviation={map.blur} result="frosted-glass" />
        </filter>
      </defs>
    </svg>
  );
}
