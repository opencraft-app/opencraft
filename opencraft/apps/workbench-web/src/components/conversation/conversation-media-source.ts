import { chatMediaPresentationKey, resolveChatConversationMediaSource, type ChatMeasurementReason, type ChatConversationMediaResolution } from "@opencraft/chat-render-react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";

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
  const loadKey = chatMediaPresentationKey(source, resolution.decision, {
    hostId: context.hostId, conversationId: context.conversationId, cwd: context.cwd, documentId,
  });
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly source: string | null;
    readonly status: "loading" | "ready" | "unavailable";
  } | null>(null);

  useEffect(() => {
    if (!resolution.loadThroughHost
      || resolution.decision.target === null
      || resolution.decision.kind === undefined
      || context.loadMediaSource === undefined) return;
    let active = true;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    setLoaded({ key: loadKey, source: null, status: "loading" });
    void context.loadMediaSource({
      signal: controller.signal,
      source,
      resolvedTarget: resolution.decision.target,
      resourceKind: resolution.decision.kind,
      documentId,
      conversationId: context.conversationId,
      hostId: context.hostId,
      cwd: context.cwd,
    }).then((result) => {
      if (!active) { result?.release?.(); return; }
      release = result?.release;
      setLoaded({
        key: loadKey,
        source: result?.source ?? null,
        status: result === null ? "unavailable" : "ready",
      });
      requestMeasurement("resource-resolve");
    }, () => {
      if (!active) return;
      setLoaded({ key: loadKey, source: null, status: "unavailable" });
      requestMeasurement("resource-resolve");
    });
    return () => { active = false; controller.abort(); release?.(); };
  }, [
    context.conversationId,
    context.cwd,
    context.hostId,
    context.loadMediaSource,
    context.onMeasurementRequest,
    documentId,
    generation,
    loadKey,
    resolution.decision.kind,
    resolution.decision.target,
    resolution.loadThroughHost,
    source,
  ]);

  if (resolution.directSource !== null) return { requestMeasurement, source: resolution.directSource, status: "ready" };
  if (!resolution.loadThroughHost) return { requestMeasurement, source: null, status: "unavailable" };
  if (loaded?.key !== loadKey) return { requestMeasurement, source: null, status: "loading" };
  return { requestMeasurement, source: loaded.source, status: loaded.status };
}
