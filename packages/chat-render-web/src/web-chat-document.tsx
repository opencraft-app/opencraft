import {
  ChatDocumentSessionView,
  type ChatExternalResourcePolicy,
  type ChatMeasurementEvent,
  type ChatRenderContext,
  type ChatRenderTheme,
} from "@opencraft/chat-render-react";
import type { ChatDocumentDialect } from "@opencraft/chat-document";
import { memo, Suspense, useEffect, useMemo, useRef } from "react";

import { useWebChatRenderRuntime } from "./runtime-context";
import { handleMarkdownCopy } from "./markdown-copy";

export interface WebChatDocumentProps {
  readonly documentId: string;
  readonly source: string;
  readonly streaming?: boolean;
  readonly theme?: ChatRenderTheme;
  readonly externalResourcePolicy?: ChatExternalResourcePolicy;
  readonly conversationId?: string | null;
  readonly turnId?: string | null;
  readonly hostId?: string | null;
  readonly cwd?: string | null;
  readonly allowWideBlocks?: boolean;
  readonly stickyCodeHeaders?: boolean;
  readonly onOpenResource?: ChatRenderContext["openResource"];
  readonly loadMediaSource?: ChatRenderContext["loadMediaSource"];
  readonly onMeasurementRequest?: (event: ChatMeasurementEvent) => void;
  readonly dialect?: ChatDocumentDialect;
}

function RawDocument({ source }: { readonly source: string }) {
  return <div className="opencraft-chat-document-fallback">{source}</div>;
}

function ResolvedWebChatDocument(props: WebChatDocumentProps) {
  const runtime = useWebChatRenderRuntime();
  const rootRef = useRef<HTMLDivElement>(null);
  const generationRef = useRef({ source: props.source, value: 1 });
  if (generationRef.current.source !== props.source) {
    generationRef.current = {
      source: props.source,
      value: generationRef.current.value + 1,
    };
  }
  const documentGeneration = generationRef.current.value;
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const ownerDocument = root.ownerDocument;
    const listener = (event: ClipboardEvent) => handleMarkdownCopy(event, root);
    ownerDocument.addEventListener("copy", listener, { capture: true });
    return () => ownerDocument.removeEventListener("copy", listener, { capture: true });
  }, []);
  const context = useMemo<Omit<ChatRenderContext, "documentId" | "streaming">>(() => ({
    theme: props.theme ?? "light",
    externalResourcePolicy: props.externalResourcePolicy ?? "allow",
    conversationId: props.conversationId ?? null,
    turnId: props.turnId ?? null,
    hostId: props.hostId ?? null,
    cwd: props.cwd ?? null,
    allowWideBlocks: props.allowWideBlocks ?? true,
    stickyCodeHeaders: props.stickyCodeHeaders ?? false,
    loadMediaSource: props.loadMediaSource,
    openResource: props.onOpenResource ?? ((target, decision) => {
      if (decision.kind === "anchor") {
        const id = decodeURIComponent(target.slice(1));
        document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      window.open(target, "_blank", "noopener,noreferrer");
    }),
    requestMeasurement: props.onMeasurementRequest === undefined
      ? undefined
      : (request) => props.onMeasurementRequest?.({
          ...request,
          documentId: props.documentId,
          generation: documentGeneration,
        }),
  }), [
    props.allowWideBlocks,
    props.conversationId,
    props.cwd,
    props.externalResourcePolicy,
    props.hostId,
    props.loadMediaSource,
    props.onMeasurementRequest,
    props.onOpenResource,
    props.stickyCodeHeaders,
    props.theme,
    props.turnId,
    documentGeneration,
    props.documentId,
  ]);
  return (
    <div
      className="opencraft-chat-document"
      data-selection="text"
      data-chat-document-dialect={props.dialect ?? "assistant"}
      data-markdown-animated={props.streaming || undefined}
      data-markdown-text-style="prose"
      dir="auto"
      ref={rootRef}
    >
      <ChatDocumentSessionView
        context={context}
        dialect={props.dialect}
        documentId={props.documentId}
        fallback={({ source, retry }) => (
          <div className="opencraft-chat-document-error">
            <RawDocument source={source} />
            <button onClick={retry} type="button">Retry rendering</button>
          </div>
        )}
        runtime={runtime}
        source={props.source}
        streaming={props.streaming ?? false}
      />
    </div>
  );
}

export const WebChatDocument = memo(function WebChatDocument(props: WebChatDocumentProps) {
  return (
    <Suspense fallback={<div className="opencraft-chat-document-fallback" aria-busy="true" />}>
      <ResolvedWebChatDocument {...props} />
    </Suspense>
  );
});

export type WebUserMessageDocumentProps = Omit<WebChatDocumentProps, "dialect" | "streaming">;

export function WebUserMessageDocument(props: WebUserMessageDocumentProps) {
  return <WebChatDocument {...props} dialect="user-message" streaming={false} />;
}
