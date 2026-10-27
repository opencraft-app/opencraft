import type { ReactNode } from "react";
import { ActivityIcon } from "./activity-icon";
import { CadencedShimmer } from "./cadenced-shimmer";

/** Shared process row paint. Callers own lifecycle and disclosure; this owner
 * keeps glyph and text feedback consistent without changing their geometry. */
export function ActivityRowContent({ icon, summary, running, iconRunning = running, summaryId }: {
  readonly icon: ReactNode;
  readonly summary: ReactNode;
  readonly running: boolean;
  /** Expanded groups hand only glyph motion to their visible running rows. */
  readonly iconRunning?: boolean;
  readonly summaryId?: string;
}) {
  return <>
    {icon == null ? null : <ActivityIcon running={iconRunning}>{icon}</ActivityIcon>}
    <CadencedShimmer active={running} className="thread-activity-item__summary" id={summaryId}>{summary}</CadencedShimmer>
  </>;
}
