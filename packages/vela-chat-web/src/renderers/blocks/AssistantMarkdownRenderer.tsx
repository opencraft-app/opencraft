import type { WebBlock } from "../../adapters/toWebBlocks";
import { Message } from "../../primitives/message/Message";
import { MessageResponse } from "../../primitives/message/MessageResponse";

export function AssistantMarkdownRenderer({
  block,
}: {
  block: Extract<WebBlock, { kind: "assistant_markdown" }>;
}) {
  return (
    <Message from="assistant">
      {block.blocks.map((markdownBlock) => (
        <MessageResponse key={markdownBlock.id} streaming={block.streaming}>
          {markdownBlock.text}
        </MessageResponse>
      ))}
    </Message>
  );
}
