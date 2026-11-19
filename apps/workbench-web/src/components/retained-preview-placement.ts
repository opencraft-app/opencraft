import { isPreviewCompositionMutation, previewCompositionOpacity } from "./retained-preview-composition";
export interface PreviewClip {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  bottomRadius?: number;
}
const flightClips = new WeakMap<HTMLElement, PreviewClip>();

/** A flight has already resolved its physical geometry. Native and atomic
 * previews consume this projection; observer echoes must not remeasure it. */
export interface PreviewFlightProjection {
  content: { x: number; y: number; width: number; height: number };
  clip: PreviewClip;
  opacity: number;
  frame: { x: number; y: number; width: number; height: number };
  radius: number;
  shadow: string;
}
const flightProjections = new WeakMap<HTMLElement, PreviewFlightProjection>();
export function setPreviewFlightProjection(frame: HTMLElement, projection: PreviewFlightProjection | null) {
  if (projection) flightProjections.set(frame, projection);
  else flightProjections.delete(frame);
}
export function getPreviewFlightProjection(target: HTMLElement) {
  const frame = target.closest<HTMLElement>("[data-overview-flight]");
  return frame ? flightProjections.get(frame) : undefined;
}

/** One physical aperture for the frame and any separately painted native view. */
export function measurePreviewClip(target: HTMLElement): PreviewClip {
  const rect = target.getBoundingClientRect();
  let left = Math.max(0, rect.left),
    top = Math.max(0, rect.top);
  let right = Math.min(innerWidth, rect.right),
    bottom = Math.min(innerHeight, rect.bottom);
  for (let element = target.parentElement; element; element = element.parentElement) {
    const style = getComputedStyle(element),
      box = element.getBoundingClientRect();
    if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
      left = Math.max(left, box.left);
      right = Math.min(right, box.right);
    }
    if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.bottom);
    }
  }
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
    radius: Number.parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0,
    bottomRadius: Number.parseFloat(getComputedStyle(target).borderBottomLeftRadius) || 0,
  };
}
export const getPreviewFlightClip = (frame: HTMLElement) => flightClips.get(frame);
export function setPreviewFlightClip(
  frame: HTMLElement,
  clip: PreviewClip | null,
  bounds?: { x: number; y: number; width: number; height: number },
  decoration?: { x: number; y: number; width: number; height: number },
) {
  if (!clip) {
    flightClips.delete(frame);
    return;
  }
  flightClips.set(frame, clip);
  const box = bounds ?? frame.getBoundingClientRect();
  // The frame already clips its content with overflow/radius. Only a scrollport
  // cut may clip its decoration; clipping to its own border suppresses shadows
  // throughout motion and reveals them in a single frame during cleanup.
  const aperture = decoration ?? clip;
  const cuts = [
    aperture.y - box.y,
    box.x + box.width - aperture.x - aperture.width,
    box.y + box.height - aperture.y - aperture.height,
    aperture.x - box.x,
  ];
  frame.style.clipPath = decoration
    ? "inset(" + cuts.map((cut) => cut + "px").join(" ") + ")"
    : previewClipPath(box, clip);
}
function previewClipPath(box: { x: number; y: number; width: number; height: number }, clip: PreviewClip, scale = 1) {
  return `inset(${Math.max(0, clip.y - box.y) / scale}px ${Math.max(0, box.x + box.width - clip.x - clip.width) / scale}px ${Math.max(0, box.y + box.height - clip.y - clip.height) / scale}px ${Math.max(0, clip.x - box.x) / scale}px round ${clip.radius / scale}px${clip.bottomRadius === undefined ? "" : ` ${clip.radius / scale}px ${clip.bottomRadius / scale}px ${clip.bottomRadius / scale}px`})`;
}

export const retainedPreviewLayoutEvent = "retained-preview-layout";
export type PreviewAnchor = "start" | "end";
export function retainedPreviewFrame(
  size: { width: number; height: number },
  target: { width: number; height: number },
  anchor: PreviewAnchor,
  contentEnd = size.height,
) {
  const scale = Math.min(1, target.width / size.width);
  return {
    scale,
    y: anchor === "end" ? Math.min(0, target.height - Math.min(size.height, Math.max(0, contentEnd)) * scale) : 0,
  };
}

interface NativePlacement {
  moveBefore?: (node: Node, before: Node | null) => void;
  showPopover?: () => void;
  hidePopover?: () => void;
}
export const canMoveRetainedView = (parent: HTMLElement) =>
  typeof (parent as NativePlacement).moveBefore === "function";
export const canFloatRetainedView = (view: HTMLElement) => typeof (view as NativePlacement).showPopover === "function";

/** Lift only a presentation frame. The existing Radix dialog still owns focus,
 * modality and dismissal. Unsupported engines use the caller's immediate path. */
export function liftPreviewFrame(frame: HTMLElement): (() => void) | undefined {
  if (!canFloatRetainedView(frame) || frame.hasAttribute("popover")) return undefined;
  // A top-layer box leaves flex/grid flow. Keep its slot allocated so its
  // destination and siblings cannot move underneath the active flight.
  const placeholder = document.createElement("div");
  const sceneLayout = frame.dataset.overviewCardLayout === "scene";
  if (sceneLayout) placeholder.dataset.overviewCardLayout = "scene";
  placeholder.inert = true;
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.setAttribute("data-overview-flight-slot", "");
  // Layout-only heading/preview slots follow responsive tokens. Never clone the
  // live chat, iframe, terminal or canvas that the frame presents.
  const heading = frame.querySelector<HTMLElement>(".panel-overview-card__heading");
  if (heading) {
    const slot = heading.cloneNode(true) as HTMLElement;
    slot.removeAttribute("style");
    slot.dataset.flightHeadingSlot = "";
    for (const node of [slot, ...slot.querySelectorAll("[id]")]) node.removeAttribute("id");
    placeholder.append(slot);
  }
  const content = document.createElement("div");
  content.className = "panel-overview-card__preview";
  content.dataset.flightContentSlot = "";
  const kind = frame.querySelector<HTMLElement>(".panel-overview-card__preview")?.dataset.previewKind;
  if (kind) content.dataset.previewKind = kind;
  placeholder.append(content);
  Object.assign(placeholder.style, {
    position: "relative",
    minWidth: "0",
    width: "100%",
    visibility: "hidden",
    pointerEvents: "none",
    flex: "none",
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    height: frame.matches(".panel-overview-primary, .panel-overview-create")
      ? "var(--height-tool-overview-entry)"
      : "var(--height-tool-overview-card)",
    padding: sceneLayout ? "0" : "var(--padding-tool-overview-card)",
    border: sceneLayout ? "0" : "var(--width-tool-overview-border) solid transparent",
    borderRadius: "var(--radius-tool-overview-card)",
  });
  frame.before(placeholder);
  frame.setAttribute("popover", "manual");
  try {
    (frame as NativePlacement).showPopover!();
  } catch {
    frame.removeAttribute("popover");
    placeholder.remove();
    return undefined;
  }
  return () => {
    try {
      (frame as NativePlacement).hidePopover?.();
    } catch {
      /* detached owner */
    }
    frame.removeAttribute("popover");
    placeholder.remove();
  };
}

/** Atomic DOM moves preserve iframe browsing contexts, media and canvas state. */
export function moveRetainedView(parent: HTMLElement, view: HTMLElement) {
  if (!parent.isConnected || !view.isConnected || !canMoveRetainedView(parent)) return false;
  try {
    (parent as NativePlacement).moveBefore!(view, null);
    return true;
  } catch {
    return false;
  }
}

/** A native view escapes the card stacking context. Transfer decoration paint
 * above it, rather than leaving half a card's perimeter underneath its content.
 * This is a presentation lease only: no cloned resource, focus or input owner. */
function leaseFloatingDecoration(target: HTMLElement) {
  const frame = target.closest<HTMLElement>('[data-overview-card-layout="scene"]');
  if (!frame) return undefined;
  const plane = document.createElement("div");
  plane.className = "retained-preview-decoration";
  plane.inert = true;
  plane.setAttribute("aria-hidden", "true");
  plane.setAttribute("popover", "manual");
  frame.append(plane);
  try {
    (plane as NativePlacement).showPopover!();
  } catch {
    plane.remove();
    return undefined;
  }
  frame.dataset.overviewDecorationOwner = "external";
  const anchor = CSS.supports("top", "anchor(--preview top)") ? leaseAnchor(frame) : undefined;
  return {
    raise() {
      try {
        (plane as NativePlacement).hidePopover?.();
        (plane as NativePlacement).showPopover?.();
      } catch {
        /* detached lease */
      }
    },
    paintOpacity(opacity: number) {
      plane.style.opacity = String(opacity);
    },
    paint(opacity: number) {
      const projection = getPreviewFlightProjection(target);
      if (projection) {
        const { frame: rect, radius, shadow } = projection;
        Object.assign(plane.style, {
          left: rect.x + "px",
          top: rect.y + "px",
          width: rect.width + "px",
          height: rect.height + "px",
          borderRadius: radius + "px",
          opacity: String(opacity),
          clipPath: frame.style.clipPath,
          visibility: "visible",
          boxShadow: shadow,
        });
        // Flight coordinates are already viewport-relative; no anchor readback.
        plane.style.removeProperty("position-anchor");
        return;
      }
      const rect = frame.getBoundingClientRect(),
        css = getComputedStyle(frame);
      const scroll = frame.closest<HTMLElement>(".panel-overview__scroll");
      const aperture = measurePreviewClip(scroll ?? frame.parentElement!);
      const clip = frame.hasAttribute("data-overview-flight")
        ? frame.style.clipPath
        : "inset(" +
          [
            aperture.y - rect.y,
            rect.right - aperture.x - aperture.width,
            rect.bottom - aperture.y - aperture.height,
            aperture.x - rect.x,
          ]
            .map((n) => n + "px")
            .join(" ") +
          ")";
      Object.assign(plane.style, {
        left: rect.x + "px",
        top: rect.y + "px",
        width: rect.width + "px",
        height: rect.height + "px",
        borderRadius: css.borderRadius,
        opacity: String(opacity),
        clipPath: clip,
        visibility: aperture.width > 0 && aperture.height > 0 ? "visible" : "hidden",
        boxShadow:
          css.getPropertyValue("--overview-frame-shadow").trim() ||
          css.getPropertyValue("--shadow-tool-overview-card").trim(),
      });
      if (anchor) {
        plane.style.setProperty("position-anchor", anchor.name);
        plane.style.left = "anchor(" + anchor.name + " left)";
        plane.style.top = "anchor(" + anchor.name + " top)";
      }
    },
    release() {
      anchor?.release();
      delete frame.dataset.overviewDecorationOwner;
      try {
        (plane as NativePlacement).hidePopover?.();
      } catch {
        /* detached lease */
      }
      plane.remove();
    },
  };
}

// Supporting engines keep the borrowed view in the anchor's native scroll chain.
// JS retains scale/clip ownership; older engines retain measured positioning.
let anchorIdentity = 0;
function leaseAnchor(element: HTMLElement) {
  const name = "--retained-preview-" + ++anchorIdentity;
  const previous = element.style.getPropertyValue("anchor-name");
  element.style.setProperty("anchor-name", previous && previous !== "none" ? previous + ", " + name : name);
  return {
    name,
    release() {
      if (previous) element.style.setProperty("anchor-name", previous);
      else element.style.removeProperty("anchor-name");
    },
  };
}
/** Without atomic DOM moves, the native top layer keeps the DOM in its home. This
 * clips its read-only paint to the card and scroll viewport; nothing is reparented. */
export function floatRetainedView(
  view: HTMLElement,
  target: HTMLElement,
  size: { width: number; height: number },
  anchor: PreviewAnchor = "start",
  contentEnd?: () => number | undefined,
) {
  const parents: HTMLElement[] = [];
  for (
    let element = target.parentElement;
    element;
    element =
      element.parentElement ??
      (element.getRootNode() instanceof ShadowRoot ? ((element.getRootNode() as ShadowRoot).host as HTMLElement) : null)
  ) {
    parents.push(element);
  }
  let decoration: ReturnType<typeof leaseFloatingDecoration>;
  let nativeAnchor: ReturnType<typeof leaseAnchor> | undefined;
  let flying = false;
  const opacityFactors = new Map<HTMLElement, number>();
  const paintOpacity = () => {
    const opacity =
      getPreviewFlightProjection(target)?.opacity ??
      [target, ...parents].reduce(
        (value, element) => value * (previewCompositionOpacity(element) ?? opacityFactors.get(element) ?? 1),
        1,
      );
    view.style.opacity = String(opacity);
    decoration?.paintOpacity(opacity);
  };
  const measure = () => {
    const frame = target.closest<HTMLElement>("[data-overview-flight]");
    const nextFlying = !!frame;
    if (nextFlying !== flying) {
      flying = nextFlying;
      // Keep the borrowed top-layer view above its moving preview frame.
      try {
        (view as NativePlacement).hidePopover?.();
        (view as NativePlacement).showPopover?.();
        decoration?.raise();
      } catch {
        /* detached owner */
      }
    }
    const projection = getPreviewFlightProjection(target);
    const rect = projection?.content ?? target.getBoundingClientRect();
    if (!target.isConnected || !rect.width || !rect.height) {
      view.style.visibility = "hidden";
      decoration?.paint(0);
      return;
    }
    const { scale, y } = retainedPreviewFrame(size, rect, anchor, contentEnd?.());
    const contentTop = rect.y + y;
    const clip =
      projection?.clip ??
      (flightClips.get(target.closest<HTMLElement>("[data-overview-view]") ?? target) ||
        (frame && flightClips.get(frame)) ||
        measurePreviewClip(
          target.parentElement?.classList.contains("panel-overview-card__preview") ? target.parentElement : target,
        ));
    // The native top layer escapes ancestor compositing as well as clipping.
    // Project the preview's presentation opacity explicitly, so sibling live
    // views leave with their cards instead of floating over the selected scene.
    if (!projection)
      for (const element of [target, ...parents])
        opacityFactors.set(element, Number(getComputedStyle(element).opacity));
    const opacity =
      projection?.opacity ??
      (frame
        ? Number(getComputedStyle(frame).opacity)
        : [...opacityFactors.values()].reduce((value, factor) => value * factor, 1));
    Object.assign(view.style, {
      opacity: String(opacity),
      left: `${rect.x}px`,
      top: `${contentTop}px`,
      transform: `scale(${scale})`,
      visibility: clip.width > 0 && clip.height > 0 ? "visible" : "hidden",
      clipPath: previewClipPath(
        { x: rect.x, y: contentTop, width: size.width * scale, height: size.height * scale },
        clip,
        scale,
      ),
    });
    if (nativeAnchor && !projection) {
      view.style.setProperty("position-anchor", nativeAnchor.name);
      view.style.left = "anchor(" + nativeAnchor.name + " left)";
      view.style.top = "calc(anchor(" + nativeAnchor.name + " top) + " + y + "px)";
    }
    if (projection) view.style.removeProperty("position-anchor");
    view.dataset.retainedPreviewScale = String(scale);
    decoration?.paint(opacity);
  };
  view.dataset.retainedPreviewPresentation = "popover";
  view.setAttribute("popover", "manual");
  try {
    (view as NativePlacement).showPopover!();
  } catch {
    view.removeAttribute("popover");
    delete view.dataset.retainedPreviewPresentation;
    return undefined;
  }
  decoration = leaseFloatingDecoration(target);
  if (target.closest('[data-overview-card-layout="scene"]') && !decoration) {
    try {
      (view as NativePlacement).hidePopover?.();
    } catch {
      /* failed placement */
    }
    view.removeAttribute("popover");
    delete view.dataset.retainedPreviewPresentation;
    return undefined;
  }
  if (CSS.supports("anchor-name", "--preview") && CSS.supports("top", "anchor(--preview top)")) {
    nativeAnchor = leaseAnchor(target);
    view.dataset.retainedPreviewPositioning = "anchor";
  }
  const resize = new ResizeObserver(measure);
  resize.observe(target);
  const mutation = new MutationObserver(function observePreviewComposition(records) {
    if (records.every(isPreviewCompositionMutation)) paintOpacity();
    else measure();
  });
  for (const element of parents) {
    resize.observe(element);
    mutation.observe(element, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["style", "class", "hidden", "data-state", "data-active", "data-theme"],
    });
  }
  // Capture nested scrolling, including native overflow scrolling on iOS.
  document.addEventListener("scroll", measure, { capture: true, passive: true });
  window.addEventListener("resize", measure, { passive: true });
  window.visualViewport?.addEventListener("resize", measure, { passive: true });
  window.visualViewport?.addEventListener("scroll", measure, { passive: true });
  target.addEventListener(retainedPreviewLayoutEvent, measure);
  measure();
  return () => {
    target.removeEventListener(retainedPreviewLayoutEvent, measure);
    resize.disconnect();
    mutation.disconnect();
    document.removeEventListener("scroll", measure, true);
    window.removeEventListener("resize", measure);
    window.visualViewport?.removeEventListener("resize", measure);
    window.visualViewport?.removeEventListener("scroll", measure);
    try {
      (view as NativePlacement).hidePopover?.();
    } catch {
      /* Browser may have already closed its top layer. */
    }
    nativeAnchor?.release();
    delete view.dataset.retainedPreviewPositioning;
    decoration?.release();
    view.removeAttribute("popover");
    delete view.dataset.retainedPreviewPresentation;
  };
}
