import type { ReactNode } from "react";
import { ActivityRowContent } from "./activity-row-content";

/** Noninteractive process summary; same visual contract as a disclosure header.
 * No feature-local class/style/size props: content and execution state only. */
export function ActivitySummaryRow({ icon, summary, running = false }: {
  readonly icon: ReactNode;
  readonly summary: ReactNode;
  readonly running?: boolean;
}) {
  return (
    <div className="thread-activity-item__header thread-activity-item__header-content">
      <ActivityRowContent icon={icon} summary={summary} running={running} />
    </div>
  );
}
