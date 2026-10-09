import { breakpoints } from "./tokens";

export type LayoutMode = "compact" | "medium" | "wide";

export function createLayoutMode(compactMax: number) {
  return (width: number): LayoutMode => {
    if (width < compactMax) {
      return "compact";
    }
    if (width < breakpoints.wide) {
      return "medium";
    }
    return "wide";
  };
}
