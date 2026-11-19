import { useChatMediaSource, resolveChatConversationMediaSource, type ChatMeasurementReason, type ChatConversationMediaResolution } from "@opencraft/chat-render-react";
import { useContext, useEffect, useMemo, useRef } from "react";

import {
  browserReadableImageSource,
  ConversationDocumentContext,
  type ConversationDocumentContextValue,
} from "./document-context";

export type ConversationMediaResolution = ChatConversationMediaResolution;

/**
 * One resource decision for every conversation-owned media surface. A Host
 * filesystem path is never handed to the browser directly; it is loaded by
 * the AppServer media boundary unless the product host supplied a mapping.
 */
export function resolveConversationMediaSource(
  source: string,
  cwd: string | null,
  resolveDirect: ConversationDocumentContextValue["resolveImageSource"],
  hasHostLoader: boolean,
): ConversationMediaResolution {
  return resolveChatConversationMediaSource(
    source, cwd, browserReadableImageSource(source, resolveDirect), hasHostLoader,
  );
}

export function useConversationMediaSource(
  source: string,
  documentId: string,
  resolveDirect: ConversationDocumentContextValue["resolveImageSource"],
  /**
   * Speculative surfaces (gallery neighbor planes) only reuse an application
   * shared media snapshot. A per-consumer loader would start one more Host
   * read for bytes another consumer already owns, so they stay empty instead.
   */
  options?: { readonly sharedOnly?: boolean },
): {
  readonly requestMeasurement: (reason: ChatMeasurementReason) => void;
  readonly source: string | null;
  readonly status: "loading" | "ready" | "unavailable";
} {
  const context = useContext(ConversationDocumentContext);
  const generationRef = useRef({ source, value: 1 });
  if (generationRef.current.source !== source) {
    generationRef.current = { source, value: generationRef.current.value + 1 };
  }
  const generation = generationRef.current.value;
  const requestMeasurement = (reason: ChatMeasurementReason) => context.onMeasurementRequest?.({
    documentId,
    generation,
    geometryChanged: true,
    reason,
  });
  const resolution = useMemo(
    () => resolveConversationMediaSource(source, context.cwd, resolveDirect, context.loadMediaSource !== undefined),
    [context.cwd, context.loadMediaSource, resolveDirect, source],
  );
  const sharedLoader = context.loadMediaSource?.getSnapshot !== undefined && context.loadMediaSource.subscribe !== undefined;
  const allowHostRead = options?.sharedOnly !== true || sharedLoader;
  const request = useMemo(() => !allowHostRead || !resolution.loadThroughHost || !resolution.decision.target || !resolution.decision.kind ? null : ({
    source, resolvedTarget: resolution.decision.target, resourceKind: resolution.decision.kind,
    documentId, conversationId: context.conversationId, hostId: context.hostId, cwd: context.cwd,
  }), [allowHostRead, resolution.loadThroughHost, resolution.decision.target, resolution.decision.kind, source, documentId, context.conversationId, context.hostId, context.cwd]);
  const loaded = useChatMediaSource(context.loadMediaSource, request);
  useEffect(() => {
    if (request && loaded.status !== "loading") context.onMeasurementRequest?.({
      documentId, generation, geometryChanged: true, reason: "resource-resolve",
    });
  }, [request, loaded, context.onMeasurementRequest, documentId, generation]);
  if (resolution.directSource !== null) return { requestMeasurement, source: resolution.directSource, status: "ready" };
  if (!resolution.loadThroughHost || !allowHostRead) return { requestMeasurement, source: null, status: "unavailable" };
  return { requestMeasurement, source: loaded.value?.source ?? null, status: loaded.status };
}
