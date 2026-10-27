import { motionValue, type MotionValue } from "motion/react";
import { useEffect, useState } from "react";

type DisclosureHeight = number | string;

/** Project animated layout onto the same CSS-pixel grid as Web scrolling. */
export function projectDisclosureHeight(height: DisclosureHeight): DisclosureHeight {
  if (typeof height === "number") return Number.isFinite(height) ? Math.round(height) : height;
  if (!/^-?\d+(?:\.\d+)?px$/.test(height)) return height;
  return `${Math.round(Number.parseFloat(height))}px`;
}

/**
 * Motion remains the sole height writer and resolves natural `auto` layout.
 * Quantize its numeric samples before layout, not after a DOM mutation or in
 * a second scroll compensator. Natural/streaming layout is not constrained.
 */
export function useDisclosureHeight(initialHeight: DisclosureHeight): MotionValue<DisclosureHeight> {
  const [height] = useState(() => {
    const value = motionValue<DisclosureHeight>(initialHeight);
    value.attach((next, commit) => commit(projectDisclosureHeight(next)), () => undefined);
    return value;
  });
  useEffect(() => () => height.destroy(), [height]);
  return height;
}
