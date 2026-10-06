import type { ChatDocumentDialect, ChatDocumentNode } from "@opencraft/chat-document";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";

import type { ChatRenderContext } from "./contracts";
import { ChatDocumentErrorBoundary, type ChatDocumentErrorFallbackProps } from "./error-boundary";
import type { ChatRenderRuntime } from "./runtime";
import { ChatFadeTimeline } from "./fade-timeline";

export interface ChatDocumentSessionViewProps {
  readonly runtime: ChatRenderRuntime;
  readonly documentId: string;
  readonly source: string;
  readonly streaming: boolean;
  readonly dialect?: ChatDocumentDialect;
  readonly context: Omit<ChatRenderContext, "documentId" | "streaming">;
  readonly fallback: (props: ChatDocumentErrorFallbackProps) => ReactNode;
}

export function ChatDocumentSessionView({
  runtime,
  documentId,
  source,
  streaming,
  dialect = "assistant",
  context,
  fallback,
}: ChatDocumentSessionViewProps) {
  const session = useMemo(() => runtime.documents.session(documentId), [runtime, documentId]);
  const fadeTimeline = useMemo(() => new ChatFadeTimeline(), [session]);
  const candidate = useMemo(
    () => session.compile(source, { dialect, streaming }),
    [dialect, session, source, streaming],
  );
  useLayoutEffect(() => candidate.commit(), [candidate]);
  useEffect(() => () => runtime.documents.release(documentId), [runtime, documentId]);

  const renderers = useSyncExternalStore(
    runtime.renderers.subscribe,
    runtime.renderers.getSnapshot,
    runtime.renderers.getSnapshot,
  );
  const resolvedContext: ChatRenderContext = useMemo(() => ({
    ...context,
    dialect,
    documentId,
    fadeTimeline,
    streaming,
  }), [context, dialect, documentId, fadeTimeline, streaming]);

  const renderNodes = useCallback((nodes: readonly ChatDocumentNode[], parentKind: ChatDocumentNode["kind"] | null = null): ReactNode => nodes.map((node, index) => {
    const directive = node.kind === "directive" ? runtime.directives.resolve(node.name) : null;
    const renderer = directive ?? runtime.renderers.resolve(renderers, node, resolvedContext);
    if (renderer === null) {
      if ("children" in node) return <Fragment key={node.stableKey}>{renderNodes(node.children, node.kind)}</Fragment>;
      if (node.kind === "text" || node.kind === "reference" || node.kind === "color-swatch") return <Fragment key={node.stableKey}>{node.text}</Fragment>;
      if (node.kind === "code-fence") return <Fragment key={node.stableKey}>{node.code}</Fragment>;
      if (node.kind === "math") return <Fragment key={node.stableKey}>{node.source}</Fragment>;
      if (node.kind === "directive") return <Fragment key={node.stableKey}>{node.raw}</Fragment>;
      return null;
    }
    const Renderer = renderer.component;
    return (
      <Renderer
        context={resolvedContext}
        key={node.stableKey}
        node={node}
        position={{
          parentKind,
          previousSiblingKind: nodes[index - 1]?.kind ?? null,
          nextSiblingKind: nodes[index + 1]?.kind ?? null,
          nextSibling: nodes[index + 1] ?? null,
        }}
        renderNodes={renderNodes}
      />
    );
  }), [renderers, resolvedContext, runtime.directives, runtime.renderers]);

  return (
    <ChatDocumentErrorBoundary fallback={fallback} source={source}>
      {renderNodes(candidate.snapshot.nodes)}
    </ChatDocumentErrorBoundary>
  );
}
