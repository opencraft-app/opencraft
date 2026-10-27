import React, { useEffect, useRef } from "react";
import { progressIndicatorGeometry } from "@opencraft/design-system/progress";
import { LoadingRingIcon } from "./action-icons";

/** Decorative progress. The consuming feedback owns its accessible status.
 * Animation uses the document timeline so separately mounted indicators stay
 * in phase; it never controls a request or delays the consumer's readiness. */
export function ProgressIndicator({ className }: { readonly className?: string }) {
  const geometry = progressIndicatorGeometry;
  const element = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = element.current;
    const view = node?.ownerDocument.defaultView;
    if (!node || !view?.matchMedia) return;
    const preference = view.matchMedia("(prefers-reduced-motion: reduce)");
    const cancel = () => { for (const animation of node.getAnimations()) animation.cancel(); };
    // Setting startTime makes the animation script-controlled. CSS removal
    // alone does not reliably cancel that animation when motion is disabled.
    const update = () => { if (preference.matches) cancel(); };
    preference.addEventListener("change", update);
    update();
    return () => { preference.removeEventListener("change", update); cancel(); };
  }, []);
  return <span className={["ui-progress-indicator", className].filter(Boolean).join(" ")}
    ref={element} aria-hidden="true" onAnimationStart={event => {
      if (event.target !== event.currentTarget) return;
      const reduced = event.currentTarget.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches;
      for (const animation of event.currentTarget.getAnimations()) {
        if (reduced) animation.cancel();
        else animation.startTime = 0;
      }
    }}>
    <LoadingRingIcon size={geometry.size} />
  </span>;
}
