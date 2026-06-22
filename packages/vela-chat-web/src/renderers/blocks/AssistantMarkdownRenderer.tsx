import type { WebBlock } from "../../adapters/toWebBlocks";
import { Message } from "../../primitives/message/Message";
import { MarkdownRenderer } from "../markdown/MarkdownRenderer";
import { StreamingMarkdownRenderer } from "../markdown/StreamingMarkdownRenderer";

export function AssistantMarkdownRenderer({
  block,
}: {
  block: Extract<WebBlock, { kind: "assistant_markdown" }>;
}) {
  return (
    <Message from="assistant">
      {block.blocks.map((markdownBlock) =>
        block.streaming ? (
          <StreamingMarkdownRenderer key={markdownBlock.id}>
            {markdownBlock.text}
          </StreamingMarkdownRenderer>
        ) : (
          <MarkdownRenderer key={markdownBlock.id}>{markdownBlock.text}</MarkdownRenderer>
        ),
      )}
    </Message>
  );
}
