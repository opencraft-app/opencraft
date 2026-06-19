import type { WebBlock } from "../../adapters/toWebBlocks";
import { Message } from "../../primitives/message/Message";
import styles from "../../styles/desktop.module.css";

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
          <span aria-hidden="true">□</span>
        </div>
      </div>
    </Message>
  );
}

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
