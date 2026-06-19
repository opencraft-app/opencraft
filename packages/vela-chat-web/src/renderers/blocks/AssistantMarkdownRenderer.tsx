import type { WebBlock } from "../../adapters/toWebBlocks";
import { Message } from "../../primitives/message/Message";
import { MessageResponse } from "../../primitives/message/MessageResponse";
import styles from "../../styles/desktop.module.css";

export function AssistantMarkdownRenderer({
  block,
}: {
  block: Extract<WebBlock, { kind: "assistant_markdown" }>;
}) {
  return (
    <Message from="assistant">
      {block.settledLabel ? <div className={styles.statusDivider}>{block.settledLabel}</div> : null}
      {block.blocks.map((markdownBlock) => (
        <MessageResponse key={markdownBlock.id} streaming={block.streaming}>
          {markdownBlock.text}
        </MessageResponse>
      ))}
    </Message>
  );
}
