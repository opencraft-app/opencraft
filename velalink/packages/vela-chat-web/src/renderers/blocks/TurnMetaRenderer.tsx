"use client";

import { useEffect, useState } from "react";
import type { WebBlock } from "../../adapters/toWebBlocks";
import styles from "../../styles/desktop.module.css";

type TurnMetaBlock = Extract<WebBlock, { kind: "turn_meta" }>;

export function TurnMetaRenderer({
  block,
}: {
  block: TurnMetaBlock;
}) {
  return (
    <div className={styles.turnMeta}>
      <div className={styles.turnHeader}>
        <TurnHeaderContent block={block} />
      </div>
    </div>
  );
}

function TurnHeaderContent({
  block,
}: {
  block: TurnMetaBlock;
}) {
  return (
    <>
      <span className={styles.turnHeaderLabel}>
        <TurnElapsedLabel block={block} />
      </span>
      <span className={styles.turnHeaderLine} aria-hidden="true" />
    </>
  );
}

function TurnElapsedLabel({ block }: { block: TurnMetaBlock }) {
  const [label, setLabel] = useState(block.label);

  useEffect(() => {
    if (block.status !== "running") {
      setLabel(block.label);
      return;
    }

    const updateLabel = () => {
      setLabel(runningTurnLabel(block.createdAt));
    };
    updateLabel();
    const id = window.setInterval(updateLabel, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [block.createdAt, block.label, block.status]);

  return <span>{label}</span>;
}

function runningTurnLabel(startedAt: string): string {
  return `处理中 ${formatDuration(Date.now() - Date.parse(startedAt))}`;
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0s";

  const totalSeconds = Math.floor(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}
