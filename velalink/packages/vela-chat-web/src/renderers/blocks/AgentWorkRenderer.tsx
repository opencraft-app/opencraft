import { useState } from "react";

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
  const [expanded, setExpanded] = useState(false);

  if (block.kind === "agent_work") {
    const summary = agentWorkVisualSummary(block.summary, block.title);
    const terminal = shellTerminalFromDetail(block.detail);

    if (terminal) {
      return (
        <div className={styles.agentWorkShell} data-status={status}>
          <button
            aria-expanded={expanded}
            aria-label={label}
            className={`${styles.agentWorkBlock} ${styles.agentWorkShellToggle}`}
            data-display={block.display}
            data-status={status}
            title={label}
            type="button"
            onClick={() => setExpanded((value) => !value)}
          >
            <span className={styles.agentWorkIcon} aria-hidden="true" />
            <span className={styles.agentWorkText}>
              <span className={styles.agentWorkTitle}>{block.title}</span>
              {summary ? <span className={styles.agentWorkSummary}>{summary}</span> : null}
            </span>
            <span className={styles.agentWorkShellChevron} aria-hidden="true">›</span>
          </button>
          {expanded ? (
            <div className={styles.agentWorkTerminal}>
              {terminal.sections.map((section) => (
                <section className={styles.agentWorkTerminalStream} key={section.id}>
                  <div className={styles.agentWorkTerminalHeader}>{section.label}</div>
                  <pre className={styles.agentWorkTerminalPre}>{section.text}</pre>
                </section>
              ))}
            </div>
          ) : null}
        </div>
      );
    }

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

type ShellTerminal = {
  sections: { id: string; label: string; text: string }[];
};

function shellTerminalFromDetail(
  detail: Extract<WebBlock, { kind: "agent_work" }>["detail"],
): ShellTerminal | undefined {
  if (!detail || detail.type !== "shell") return undefined;

  const streamSections = Array.isArray(detail.streams)
    ? detail.streams
        .map((stream) => {
          const streamId = textField(stream.stream_id) || textField(stream.stream) || "output";
          const text = textField(stream.text);
          return text ? { id: streamId, label: streamId, text } : undefined;
        })
        .filter((section): section is { id: string; label: string; text: string } => Boolean(section))
    : [];

  if (streamSections.length > 0) {
    return { sections: streamSections };
  }

  const sections = [
    { id: "stdout", label: "stdout", text: textField(detail.stdout) || textField(detail.output) },
    { id: "stderr", label: "stderr", text: textField(detail.stderr) },
  ].filter((section) => section.text.trim().length > 0);

  return sections.length > 0 ? { sections } : undefined;
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}
