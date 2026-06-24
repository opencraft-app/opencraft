import { useState } from "react";

import type { WebBlock } from "../../adapters/toWebBlocks";
import styles from "../../styles/desktop.module.css";
import { AgentWorkRenderer } from "./AgentWorkRenderer";
import { agentWorkAccessibleLabel, agentWorkVisualStatus } from "./agentWorkLabel";

export function AgentWorkGroupRenderer({
  block,
}: {
  block: Extract<WebBlock, { kind: "agent_work_group" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = agentWorkVisualStatus(block);
  const label = agentWorkAccessibleLabel(block);

  return (
    <div className={styles.agentWorkGroup} data-status={status}>
      <button
        aria-expanded={expanded}
        aria-label={label}
        className={styles.agentWorkGroupButton}
        onClick={() => setExpanded((value) => !value)}
        title={label}
        type="button"
      >
        <span className={styles.agentWorkIcon} aria-hidden="true" />
        <span className={styles.agentWorkText}>
          <span className={styles.agentWorkTitle}>{block.title}</span>
        </span>
        <span className={styles.agentWorkGroupChevron} aria-hidden="true">
          ›
        </span>
      </button>
      {expanded ? (
        <div className={styles.agentWorkGroupChildren}>
          {block.children.map((child) => (
            <AgentWorkRenderer key={child.key} block={child} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
