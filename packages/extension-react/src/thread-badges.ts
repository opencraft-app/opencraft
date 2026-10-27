import type { ComponentType } from "react";

export const THREAD_BADGE_CHANNEL = "threadBadge";
/** Shell owns an intrinsic-width slot and popover exclusivity; products own content and data. */
export interface ThreadBadgeProps {
  readonly hostId: string;
  readonly threadId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCloseAutoFocus?: (event: Event) => void;
  readonly portalContainer: HTMLElement | null;
}
export interface ThreadBadgeContribution {
  readonly id: string;
  /** Title selects a single visible title row without project/status metadata. */
  readonly placement?: "trailing" | "metadata" | "title";
  readonly Component: ComponentType<ThreadBadgeProps>;
}
