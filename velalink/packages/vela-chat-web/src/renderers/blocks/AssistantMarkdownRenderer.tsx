import { useCallback, useEffect, useState } from "react";

import type { WebBlock } from "../../adapters/toWebBlocks";
import { Message } from "../../primitives/message/Message";
import { MarkdownRenderer } from "../markdown/MarkdownRenderer";
import { StreamingMarkdownRenderer } from "../markdown/StreamingMarkdownRenderer";

export function AssistantMarkdownRenderer({
  block,
}: {
  block: Extract<WebBlock, { kind: "assistant_markdown" }>;
}) {
  const text = block.blocks.map((markdownBlock) => markdownBlock.text).join("\n\n");
  const [renderLive, setRenderLive] = useState(block.streaming);
  useEffect(() => {
    if (block.streaming) setRenderLive(true);
  }, [block.streaming]);
  const handleSettled = useCallback(() => {
    setRenderLive(false);
  }, []);

  if (block.streaming || renderLive) {
    return (
      <Message from="assistant">
        <StreamingMarkdownRenderer
          onSettled={handleSettled}
          streamKey={block.id}
          streaming={block.streaming}
        >
          {text}
        </StreamingMarkdownRenderer>
      </Message>
    );
  }

  return (
    <Message from="assistant">
      <MarkdownRenderer>{text}</MarkdownRenderer>
    </Message>
  );
}
