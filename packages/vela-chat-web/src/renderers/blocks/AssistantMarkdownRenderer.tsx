import type { WebBlock } from "../../adapters/toWebBlocks";
import { Message } from "../../primitives/message/Message";
import { MessageResponse } from "../../primitives/message/MessageResponse";
import type { CSSProperties } from "react";

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
      {block.showCopyAction && block.copyText ? (
        <div style={assistantFooterStyle}>
          <button
            aria-label="Copy assistant message"
            onClick={() => {
              void copyMessageText(block.copyText);
            }}
            style={copyButtonStyle}
            title="Copy assistant message"
            type="button"
          >
            <svg
              aria-hidden="true"
              fill="none"
              height="16"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.8"
              style={copyIconStyle}
              viewBox="0 0 24 24"
              width="16"
            >
              <rect height="13" rx="2" ry="2" width="13" x="9" y="9" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        </div>
      ) : null}
    </Message>
  );
}

const assistantFooterStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-start",
  marginTop: 2,
  color: "#8c8f94",
};

const copyButtonStyle: CSSProperties = {
  alignItems: "center",
  appearance: "none",
  background: "transparent",
  border: 0,
  color: "currentColor",
  cursor: "pointer",
  display: "inline-flex",
  height: 20,
  justifyContent: "center",
  padding: 0,
  width: 20,
};

const copyIconStyle: CSSProperties = {
  display: "block",
};

async function copyMessageText(text: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard permission failures should not interrupt the chat surface.
  }
}
