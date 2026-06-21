import type { WebBlock } from "../../adapters/toWebBlocks";
import styles from "../../styles/desktop.module.css";
import {
  activityAccessibleLabel,
  activityVisualStatus,
  activityVisualSummary,
} from "./activityLabel";

export function ActivityRenderer({
  block,
}: {
  block: Extract<WebBlock, { kind: "status" | "agent_work" }>;
}) {
  const label = activityAccessibleLabel(block);
  const status = activityVisualStatus(block);

  if (block.kind === "agent_work") {
    const summary = activityVisualSummary(block.summary, block.title);

    return (
      <div
        aria-label={label}
        className={styles.activityBlock}
        data-display={block.display}
        data-status={status}
        title={label}
      >
        <span className={styles.activityIcon} aria-hidden="true" />
        <span className={styles.activityText}>
          <span className={styles.activityTitle}>{block.title}</span>
          {summary ? <span className={styles.activitySummary}>{summary}</span> : null}
        </span>
      </div>
    );
  }

  return (
    <div
      aria-label={label}
      className={styles.activityBlock}
      data-status={status}
      title={label}
    >
      <span className={styles.activityIcon} aria-hidden="true" />
      <span className={styles.activityTitle}>{block.label}</span>
    </div>
  );
}
