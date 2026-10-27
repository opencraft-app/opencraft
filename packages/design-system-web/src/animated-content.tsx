import { animate, motion, useMotionValue } from "motion/react";
import { useMotionReduction } from "./use-motion-reduction";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { selectionMotion } from "@opencraft/design-system/tokens";

/** Animate a content-sized viewport without replacing its overlay or focus owner. */
export function AnimatedContent({ children, viewKey }: {
  readonly children: ReactNode;
  readonly viewKey: string;
}) {
  const content = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const height = useMotionValue(0);
  const reduced = useMotionReduction();
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    let previousTarget: number | undefined;
    const update = () => {
      const target = element.getBoundingClientRect().height;
      if (target === previousTarget) return;
      previousTarget = target;
      height.stop();
      if (!initialized.current || reduced) height.jump(target);
      else animate(height, target, selectionMotion.surface);
      initialized.current = true;
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => { observer.disconnect(); height.stop(); };
  }, [height, reduced, viewKey]);
  return <motion.div className="ui-animated-content" style={{ height }}>
    <div ref={content} key={viewKey} className="ui-animated-content__view">{children}</div>
  </motion.div>;
}
