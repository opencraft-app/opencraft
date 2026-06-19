import type { WebBlock } from "../../adapters/toWebBlocks";
import styles from "../../styles/desktop.module.css";
import { activityAccessibleLabel } from "./activityLabel";

export function ActivityRenderer({
  block,
}: {
  block: Extract<WebBlock, { kind: "status" | "agent_work" }>;
}) {
  const label = activityAccessibleLabel(block);

  if (block.kind === "agent_work") {
    return (
      <div
        aria-label={label}
        className={styles.activityBlock}
        data-display={block.display}
        data-status={block.status}
        title={label}
      >
        <span className={styles.activityDot} aria-hidden="true" />
        <span className={styles.activityText}>
          <span className={styles.activityTitle}>{block.title}</span>
          {block.summary ? <span className={styles.activitySummary}>{block.summary}</span> : null}
        </span>
      </div>
    );
  }

  return (
    <div aria-label={label} className={styles.activityBlock} title={label}>
      <span className={styles.activityDot} aria-hidden="true" />
      <span>{block.label}</span>
    </div>
  );
}
