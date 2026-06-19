import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { memo } from "react";
import { Streamdown } from "streamdown";
import styles from "../../styles/desktop.module.css";

export interface MessageResponseProps {
  children: string;
  streaming?: boolean;
}

const streamdownPlugins = { cjk, code };

export const MessageResponse = memo(function MessageResponse({
  children,
  streaming = false,
}: MessageResponseProps) {
  return (
    <Streamdown
      className={styles.messageResponse}
      mode={streaming ? "streaming" : "static"}
      plugins={streamdownPlugins}
    >
      {children}
    </Streamdown>
  );
}, areEqual);

function areEqual(prev: MessageResponseProps, next: MessageResponseProps) {
  return prev.children === next.children && prev.streaming === next.streaming;
}
