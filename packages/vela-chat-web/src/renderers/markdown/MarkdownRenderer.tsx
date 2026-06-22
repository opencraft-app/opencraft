import { memo, useMemo } from "react";

import styles from "../../styles/desktop.module.css";
import { parseMarkdownTokens } from "./parse";
import { renderMarkdownTokens } from "./renderTokens";

export interface MarkdownRendererProps {
  children: string;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  children,
}: MarkdownRendererProps) {
  const tokens = useMemo(() => parseMarkdownTokens(children), [children]);

  return <div className={styles.messageResponse}>{renderMarkdownTokens(tokens)}</div>;
}, areEqual);

function areEqual(prev: MarkdownRendererProps, next: MarkdownRendererProps) {
  return prev.children === next.children;
}

