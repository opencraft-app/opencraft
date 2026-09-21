import type {
  ShellNavigationRailDetent,
  ShellNavigationVisibleDetent,
} from "@opencraft/workbench-runtime";

export interface SidecarPrimaryResizeTransaction {
  readonly originDetent: ShellNavigationVisibleDetent;
  readonly originWidth: number;
  readonly startClientX: number;
}

export interface SidecarPrimaryResizePreview {
  readonly candidateDetent: ShellNavigationRailDetent;
  readonly frameWidth: number;
  readonly magnetized: boolean;
}

export interface SidecarPrimaryResizeCommit {
  readonly detent: ShellNavigationRailDetent;
  readonly expandedWidth: number | null;
  readonly originDetent: ShellNavigationVisibleDetent;
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

export function beginSidecarPrimaryResize(input: {
  readonly clientX: number;
  readonly detent: ShellNavigationVisibleDetent;
  readonly expandedWidth: number;
  readonly compactWidth: number;
  readonly currentWidth?: number;
}): SidecarPrimaryResizeTransaction {
  return {
    originDetent: input.detent,
    originWidth: input.currentWidth ?? (input.detent === "compact" ? input.compactWidth : input.expandedWidth),
    startClientX: input.clientX,
  };
}

/** Reflow in the normal expanded range; only the compact/hidden transition uses a layout floor. */
export function primaryViewportWidth(frameWidth: number, expandedMinimumWidth: number): number {
  return Math.max(expandedMinimumWidth, frameWidth);
}

/**
 * Resolve geometry for one pointer transaction without mutating semantic
 * navigation state. One gesture may only reach an adjacent detent.
 */
export function previewSidecarPrimaryResize(input: {
  readonly clientX: number;
  readonly compactWidth: number;
  readonly expandedMinimumWidth: number;
  readonly maximumWidth: number;
  readonly transaction: SidecarPrimaryResizeTransaction;
}): SidecarPrimaryResizePreview {
  const { transaction, compactWidth, expandedMinimumWidth, maximumWidth } = input;
  const rawWidth = transaction.originWidth + input.clientX - transaction.startClientX;
  const expandedShelf = (compactWidth + expandedMinimumWidth) / 2;

  if (transaction.originDetent === "expanded") {
    const candidateDetent = rawWidth < expandedShelf ? "compact" : "expanded";
    return {
      candidateDetent,
      frameWidth: clamp(rawWidth, compactWidth, maximumWidth),
      magnetized: candidateDetent === "compact" || rawWidth < expandedMinimumWidth,
    };
  }

  const hiddenShelf = compactWidth / 2;
  const candidateDetent = rawWidth < hiddenShelf
    ? "hidden"
    : rawWidth >= expandedShelf ? "expanded" : "compact";
  return {
    candidateDetent,
    frameWidth: clamp(rawWidth, 0, maximumWidth),
    magnetized: candidateDetent !== "expanded" || rawWidth < expandedMinimumWidth,
  };
}

/** Detents choose a release destination; they never quantize pointer frames. */
export function resolveSidecarPrimarySettleTarget(input: {
  readonly compactWidth: number;
  readonly detent: ShellNavigationRailDetent;
  readonly expandedMinimumWidth: number;
  readonly expandedWidth: number | null;
  readonly maximumWidth: number;
}): number {
  if (input.detent === "hidden") return 0;
  if (input.detent === "compact") return input.compactWidth;
  return clamp(
    input.expandedWidth ?? input.expandedMinimumWidth,
    input.expandedMinimumWidth,
    input.maximumWidth,
  );
}
