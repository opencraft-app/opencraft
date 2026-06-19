import type { WebBlock } from "../../adapters/toWebBlocks";
import { Message } from "../../primitives/message/Message";
import styles from "../../styles/desktop.module.css";
import type { CSSProperties } from "react";

export function UserMessageRenderer({
  block,
}: {
  block: Extract<WebBlock, { kind: "user_message" }>;
}) {
  const images = block.parts.filter(
    (part) =>
      part.type === "image" &&
      typeof part.data?.data === "string" &&
      typeof part.data?.mime_type === "string",
  );
  const text = block.text || textFromParts(block);
  const copyText = block.copyText || text;

  return (
    <Message from="user">
      <div className={styles.userMessageStack}>
        {images.length > 0 ? (
          <div className={styles.userImageGrid}>
            {images.map((part) => (
              <img
                alt="Uploaded image"
                className={styles.userImage}
                key={part.id}
                src={`data:${part.data?.mime_type};base64,${part.data?.data}`}
              />
            ))}
          </div>
        ) : null}
        {text ? <div className={styles.userBubble}>{text}</div> : null}
        <div className={styles.userMeta}>
          <span>{formatTime(block.createdAt)}</span>
          {copyText ? (
            <button
              aria-label="Copy message"
              onClick={() => {
                void copyMessageText(copyText);
              }}
              style={copyButtonStyle}
              title="Copy message"
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
          ) : null}
        </div>
      </div>
    </Message>
  );
}

const copyButtonStyle: CSSProperties = {
  alignItems: "center",
  appearance: "none",
  background: "transparent",
  border: 0,
  color: "currentColor",
  cursor: "pointer",
  display: "inline-flex",
  height: 18,
  justifyContent: "center",
  padding: 0,
  width: 18,
};

const copyIconStyle: CSSProperties = {
  display: "block",
};

function textFromParts(block: Extract<WebBlock, { kind: "user_message" }>) {
  return block.parts
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n");
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function copyMessageText(text: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard permission failures should not interrupt the chat surface.
  }
}
