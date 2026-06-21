import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { memo, type ComponentProps, type ReactNode } from "react";
import { Streamdown, type Components, type ControlsConfig, type ExtraProps } from "streamdown";
import styles from "../../styles/desktop.module.css";

export interface MessageResponseProps {
  children: string;
  streaming?: boolean;
}

const streamdownPlugins = { cjk, code };
const streamdownControls = {
  table: {
    copy: false,
  },
  code: {
    copy: false,
    download: false,
  },
} satisfies ControlsConfig;
const streamdownComponents = {
  code: PlainCode,
} satisfies Components;

export const MessageResponse = memo(function MessageResponse({
  children,
  streaming = false,
}: MessageResponseProps) {
  return (
    <Streamdown
      className={styles.messageResponse}
      components={streamdownComponents}
      controls={streamdownControls}
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

function PlainCode({
  children,
  className,
  node: _node,
  ...props
}: ComponentProps<"code"> & ExtraProps) {
  const isBlock = "data-block" in props;

  if (!isBlock) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }

  return (
    <pre>
      <code className={className}>{trimTrailingCodeNewline(children)}</code>
    </pre>
  );
}

function trimTrailingCodeNewline(children: ReactNode) {
  const text = childrenToText(children);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function childrenToText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map(childrenToText).join("");
  }
  return "";
}
