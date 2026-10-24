import type { ShellNavigationRailDetent } from "./shell-navigation";
import { workbenchWindowMetrics } from "./window-metrics";
export { workbenchWindowMetrics } from "./window-metrics";

export interface ShellSpaceInput {
  readonly width: number;
  readonly navigationOpen: boolean;
  readonly navigationDetent: ShellNavigationRailDetent;
  readonly navigationWidth: number;
  readonly contextOpen: boolean;
  readonly contextWidth: number;
  /** Caller-owned presentation minimum, including any inset rail. */
  readonly contextMinimumWidth?: number;
  readonly rightOpen: boolean;
  readonly rightFullWidth: boolean;
  readonly previousLevel?: number;
}

export const shellSpaceMetrics = {
  mainMinimum: workbenchWindowMetrics.minimumWidth,
  rightMinimum: 320,
  compact: 52,
  hysteresis: 32,
};

/** One window budget; the returned presentation never edits a saved preference. */
export function resolveShellSpace(input: ShellSpaceInput) {
  const { mainMinimum, rightMinimum, compact, hysteresis } = shellSpaceMetrics;
  const requestedDetent = input.navigationOpen ? input.navigationDetent : "hidden";
  const compactDetent = requestedDetent === "expanded" ? "compact" : requestedDetent;
  const candidates = [
    { detent: requestedDetent, context: input.contextOpen, right: input.rightOpen },
    { detent: compactDetent, context: input.contextOpen, right: input.rightOpen },
    { detent: "hidden", context: input.contextOpen, right: input.rightOpen },
    { detent: "hidden", context: input.contextOpen, right: false },
    { detent: "hidden", context: false, right: false },
  ] as const;
  for (const [level, candidate] of candidates.entries()) {
    const navigationWidth = candidate.detent === "expanded" ? input.navigationWidth
      : candidate.detent === "compact" ? compact : 0;
    const leftWidth = navigationWidth + (candidate.context ? Math.max(input.contextWidth, input.contextMinimumWidth ?? 0) : 0);
    // Explicit full-width tools replace the main viewport; ordinary tools share it.
    const contentReserve = candidate.right && input.rightFullWidth ? mainMinimum
      : mainMinimum + (candidate.right ? rightMinimum : 0);
    const restoring = input.previousLevel !== undefined && level < input.previousLevel;
    if (level !== candidates.length - 1 && input.width < leftWidth + contentReserve + (restoring ? hysteresis : 0)) continue;
    return {
      level, navigationDetent: candidate.detent, navigationWidth,
      navigationOpen: navigationWidth > 0, contextOpen: candidate.context,
      rightOpen: candidate.right, leftWidth,
      rightAvailable: input.width - leftWidth >= mainMinimum + rightMinimum,
    };
  }
  throw new Error("Shell space must have an immersive fallback");
}

export type ShellSpaceProjection = ReturnType<typeof resolveShellSpace>;
