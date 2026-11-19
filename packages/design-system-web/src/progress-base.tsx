import React, { useEffect, useRef } from "react";
import { progressIndicatorGeometry } from "@opencraft/design-system/progress";
import { LoadingRingIcon } from "./action-icons";

/** Decorative progress. The consuming feedback owns its accessible status.
 * Animation uses the document timeline so separately mounted indicators stay
 * in phase; it never controls a request or delays the consumer's readiness. */
export function ProgressIndicatorBase({
  className,
  value,
  size,
  variant = "ring",
}: {
  readonly variant?: "ring" | "bar";
  readonly className?: string;
  /** A fraction in [0, 1], omitted when the operation has no measurable progress. */
  readonly value?: number;
  readonly size?: number;
}) {
  const geometry = progressIndicatorGeometry;
  const determinate = value !== undefined && Number.isFinite(value);
  const fraction = determinate ? Math.max(0, Math.min(1, value)) : 0;
  const diameter = size !== undefined && Number.isFinite(size) && size > 0 ? size : geometry.size;
  const element = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = element.current;
    const view = node?.ownerDocument.defaultView;
    if (!node || !view?.matchMedia) return;
    const preference = view.matchMedia("(prefers-reduced-motion: reduce)");
    const cancel = () => {
      for (const animation of node.getAnimations({ subtree: true })) animation.cancel();
    };
    // Setting startTime makes the animation script-controlled. CSS removal
    // alone does not reliably cancel that animation when motion is disabled.
    const update = () => {
      if (preference.matches) cancel();
    };
    preference.addEventListener("change", update);
    update();
    return () => {
      preference.removeEventListener("change", update);
      cancel();
    };
  }, []);
  useEffect(() => {
    if (determinate)
      for (const animation of element.current?.getAnimations({ subtree: true }) ?? []) animation.cancel();
  }, [determinate]);
  return (
    <span
      className={["ui-progress-indicator", className].filter(Boolean).join(" ")}
      ref={element}
      aria-hidden="true"
      data-variant={variant}
      data-determinate={determinate || undefined}
      style={size === undefined ? undefined : { width: diameter, height: diameter }}
      onAnimationStart={(event) => {
        const reduced = event.currentTarget.ownerDocument.defaultView?.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        for (const animation of event.currentTarget.getAnimations({ subtree: true })) {
          if (reduced || determinate) animation.cancel();
          else animation.startTime = 0;
        }
      }}
    >
      {variant === "bar" ? (
        <span
          className="ui-progress-indicator__fill"
          style={determinate ? { width: `${fraction * 100}%` } : undefined}
        />
      ) : determinate ? (
        <svg width={diameter} height={diameter} viewBox={geometry.viewBox} fill="none">
          <circle
            cx={geometry.center}
            cy={geometry.center}
            r={geometry.radius}
            stroke="currentColor"
            strokeWidth={geometry.strokeWidth}
            opacity={geometry.trackOpacity}
          />
          <circle
            cx={geometry.center}
            cy={geometry.center}
            r={geometry.radius}
            stroke="currentColor"
            strokeWidth={geometry.strokeWidth}
            pathLength="1"
            strokeDasharray={fraction + " 1"}
            strokeLinecap="round"
            transform={"rotate(-90 " + geometry.center + " " + geometry.center + ")"}
          />
        </svg>
      ) : (
        <LoadingRingIcon size={diameter} />
      )}
    </span>
  );
}
