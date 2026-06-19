import type { WebBlock } from "../../adapters/toWebBlocks";
import styles from "../../styles/desktop.module.css";

export function StatusRenderer({
  block,
}: {
  block: Extract<WebBlock, { kind: "status" }>;
}) {
  return <div className={styles.statusDivider}>{block.label}</div>;
}
