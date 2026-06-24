import type { WebBlock } from "../../adapters/toWebBlocks";
import styles from "../../styles/desktop.module.css";
import {
  agentWorkAccessibleLabel,
  agentWorkVisualStatus,
  agentWorkVisualSummary,
} from "./agentWorkLabel";

export function AgentWorkRenderer({
  block,
}: {
  block: Extract<WebBlock, { kind: "status" | "agent_work" }>;
}) {
  const label = agentWorkAccessibleLabel(block);
  const status = agentWorkVisualStatus(block);

  if (block.kind === "agent_work") {
    const summary = agentWorkVisualSummary(block.summary, block.title);

    return (
      <div
        aria-label={label}
        className={styles.agentWorkBlock}
        data-display={block.display}
        data-status={status}
        title={label}
      >
        <span className={styles.agentWorkIcon} aria-hidden="true" />
        <span className={styles.agentWorkText}>
          <span className={styles.agentWorkTitle}>{block.title}</span>
          {summary ? <span className={styles.agentWorkSummary}>{summary}</span> : null}
        </span>
      </div>
    );
  }

  return (
    <div
      aria-label={label}
      className={styles.agentWorkBlock}
      data-status={status}
      title={label}
    >
      <span className={styles.agentWorkIcon} aria-hidden="true" />
      <span className={styles.agentWorkTitle}>{block.label}</span>
    </div>
  );
}
