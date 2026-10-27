import type { ChatDocumentCodeFenceNode } from "@opencraft/chat-document";
import type { ChatRenderContext } from "@opencraft/chat-render-react";
import { useMemo, type ReactNode } from "react";

import { ShikiCodeRenderer } from "../../extensions/shiki/shiki-code";
import { useWebChatRenderRuntime } from "../../runtime-context";
import { resolveCodeSurfacePolicy } from "./code-block-model";

export interface LazyHighlightedCodeSurfaceProps {
  readonly className?: string;
  readonly code: string;
  readonly documentId: string;
  readonly language: string | null;
  readonly showActions?: boolean;
  readonly theme?: "light" | "dark";
  readonly title?: ReactNode;
}

/**
 * Typed entry for compact, non-Markdown previews. The historical name remains
 * descriptive of the engine boundary; the React surface itself is no longer
 * lazy or replaceable.
 */
export function LazyHighlightedCodeSurface({
  className,
  code,
  documentId,
  language,
  showActions = true,
  theme = "light",
  title,
}: LazyHighlightedCodeSurfaceProps) {
  const runtime = useWebChatRenderRuntime();
  const node = useMemo<ChatDocumentCodeFenceNode>(() => ({
    kind: "code-fence",
    stableKey: `${documentId}:code`,
    completeness: "complete",
    sourceRange: { start: 0, end: code.length },
    language,
    code,
    meta: null,
  }), [code, documentId, language]);
  const context = useMemo<ChatRenderContext>(() => ({
    documentId,
    theme,
    externalResourcePolicy: "restricted",
    streaming: false,
    allowWideBlocks: false,
  }), [documentId, theme]);

  return (
    <div className={className}>
      <ShikiCodeRenderer
        context={context}
        enhancements={runtime.context.chatEnhancements}
        node={node}
        renderNodes={() => null}
        surfaceProps={{
          policy: resolveCodeSurfacePolicy({ code, language, variant: "preview" }),
          showActions,
          title,
        }}
      />
    </div>
  );
}
