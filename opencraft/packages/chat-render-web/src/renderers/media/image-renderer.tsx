import { chatMediaPresentationKey, type ChatNodeRendererProps, type ChatResourcePolicyService } from "@opencraft/chat-render-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { usePreviewFocusOrigin } from "../../preview-focus-origin";
import "./image.scss";

function CloseGlyph() {
  return <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m3.5 3.5 9 9m0-9-9 9" /></svg>;
}

function PreviousGlyph() {
  return <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m10 3-5 5 5 5" /></svg>;
}

function NextGlyph() {
  return <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m6 3 5 5-5 5" /></svg>;
}

interface ImageGalleryState {
  readonly key: string;
  readonly index: number;
  readonly items: readonly { readonly alt: string; readonly source: string }[];
}

export function createImageRenderer(resources: ChatResourcePolicyService) {
  return function ImageRenderer({ node, context }: ChatNodeRendererProps) {
    const [gallery, setGallery] = useState<ImageGalleryState | null>(null);
    const [mediaState, setMediaState] = useState<{
      readonly key: string;
      readonly source: string | null;
      readonly status: "loading" | "ready" | "unavailable";
    } | null>(null);
    const dialogRef = useRef<HTMLDialogElement>(null);
    const previewFocus = usePreviewFocusOrigin();
    if (node.kind !== "image") return null;
    // Codex's media normalizer permits media data URLs, while the generic
    // anchor policy rejects every data: URL. Keep that exception local to the
    // image renderer so it cannot weaken link navigation safety.
    const decision = /^data:image\//iu.test(node.src)
      ? { allowed: true as const, kind: "external" as const, target: node.src }
      : resources.resolve(node.src, context);
    const loadKey = chatMediaPresentationKey(node.src, decision, context);
    const activeGallery = gallery?.key === loadKey ? gallery : null;
    useEffect(() => {
      const dialog = dialogRef.current;
      if (dialog === null) return;
      if (activeGallery !== null && !dialog.open) dialog.showModal();
      if (activeGallery === null && dialog.open) dialog.close();
    }, [activeGallery]);
    useEffect(() => {
      if (gallery !== null && gallery.key !== loadKey) setGallery(null);
    }, [gallery, loadKey]);
    const mustLoadThroughHost = decision.allowed
      && decision.target !== null
      && context.loadMediaSource !== undefined
      && (decision.kind === "file"
        || decision.kind === "workspace-file"
        || decision.kind === "resource");
    const directSource = decision.allowed && decision.target !== null && !mustLoadThroughHost
      ? decision.target
      : null;
    const effectiveState = useMemo(() => {
      if (mediaState?.key === loadKey && mediaState.status === "unavailable") return mediaState;
      if (!mustLoadThroughHost) {
        return directSource === null
          ? { key: loadKey, source: null, status: "unavailable" as const }
          : { key: loadKey, source: directSource, status: "ready" as const };
      }
      return mediaState?.key === loadKey
        ? mediaState
        : { key: loadKey, source: null, status: "loading" as const };
    }, [directSource, loadKey, mediaState, mustLoadThroughHost]);
    useEffect(() => {
      if (!mustLoadThroughHost || decision.target === null || context.loadMediaSource === undefined) return;
      let active = true;
      const controller = new AbortController();
      let release: (() => void) | undefined;
      setMediaState({ key: loadKey, source: null, status: "loading" });
      void context.loadMediaSource({
        signal: controller.signal,
        source: node.src,
        resolvedTarget: decision.target,
        resourceKind: decision.kind!,
        documentId: context.documentId,
        conversationId: context.conversationId ?? null,
        hostId: context.hostId ?? null,
        cwd: context.cwd ?? null,
      }).then((result) => {
        if (!active) { result?.release?.(); return; }
        release = result?.release;
        setMediaState({
          key: loadKey,
          source: result?.source ?? null,
          status: result === null ? "unavailable" : "ready",
        });
        context.requestMeasurement?.({ geometryChanged: true, reason: "resource-resolve" });
      }, () => {
        if (!active) return;
        setMediaState({ key: loadKey, source: null, status: "unavailable" });
        context.requestMeasurement?.({ geometryChanged: true, reason: "resource-resolve" });
      });
      return () => { active = false; controller.abort(); release?.(); };
    }, [
      context.conversationId,
      context.cwd,
      context.documentId,
      context.hostId,
      context.requestMeasurement,
      context.loadMediaSource,
      decision.kind,
      decision.target,
      loadKey,
      mustLoadThroughHost,
      node.src,
    ]);
    if (!decision.allowed || decision.target === null) {
      return <span className="chat-markdown-media-unavailable" role="img" title={decision.reason}>{node.alt || "Image unavailable"}</span>;
    }
    if (effectiveState.status === "loading") {
      return <span aria-label={node.alt || "Image loading"} className="chat-markdown-media-placeholder" data-state="loading" role="img" />;
    }
    if (effectiveState.status === "unavailable" || effectiveState.source === null) {
      return <span className="chat-markdown-media-unavailable" role="img">{node.alt || "Image unavailable"}</span>;
    }
    const imageSource = effectiveState.source;
    const close = () => setGallery(null);
    const markUnavailable = () => {
      setMediaState({ key: loadKey, source: null, status: "unavailable" });
      context.requestMeasurement?.({ geometryChanged: true, reason: "image-load" });
    };
    const openGallery = (trigger: HTMLButtonElement) => {
      const root = trigger.closest(".opencraft-chat-document");
      const triggers = root === null
        ? [trigger]
        : [...root.querySelectorAll<HTMLButtonElement>("[data-markdown-image-preview-trigger]")];
      const items = triggers.flatMap((candidate) => {
        const image = candidate.querySelector("img");
        return image === null ? [] : [{ alt: image.alt, source: image.currentSrc || image.src }];
      });
      const index = Math.max(0, triggers.indexOf(trigger));
      setGallery({ key: loadKey, index: Math.min(index, Math.max(0, items.length - 1)), items });
    };
    const currentImage = activeGallery?.items[activeGallery.index] ?? { alt: node.alt, source: imageSource };
    const showPrevious = activeGallery !== null && activeGallery.index > 0;
    const showNext = activeGallery !== null && activeGallery.index + 1 < activeGallery.items.length;
    return (
      <>
        <button aria-label={node.alt || "Preview image"} className="chat-markdown-image-button" data-markdown-image-preview-trigger="true" onClick={(event) => { previewFocus.recordOpen(event); openGallery(event.currentTarget); }} onKeyDown={previewFocus.onTriggerKeyDown} onPointerCancel={previewFocus.onTriggerPointerCancel} onPointerDown={previewFocus.onTriggerPointerDown} type="button">
          <img
            alt={node.alt}
            className="chat-markdown-image"
            loading="lazy"
            onError={markUnavailable}
            onLoad={() => context.requestMeasurement?.({ geometryChanged: true, reason: "image-load" })}
            src={imageSource}
            title={node.title ?? undefined}
          />
        </button>
        <dialog aria-label={currentImage.alt || "Image preview"} className="chat-markdown-image-preview" data-opened-by-pointer={previewFocus.openedByPointer || undefined} onCancel={(event) => { event.preventDefault(); close(); }} onClose={close} onKeyDown={(event) => {
          previewFocus.onPreviewKeyDown(event);
          if (activeGallery === null) return;
          if (event.key === "ArrowLeft" && showPrevious) setGallery({ ...activeGallery, index: activeGallery.index - 1 });
          if (event.key === "ArrowRight" && showNext) setGallery({ ...activeGallery, index: activeGallery.index + 1 });
        }} ref={dialogRef}>
          <button aria-label="Close image preview" className="chat-markdown-image-preview__close" onClick={close} type="button"><CloseGlyph /></button>
          {showPrevious ? <button aria-label="Previous image" className="chat-markdown-image-preview__previous" onClick={() => setGallery((current) => current?.key !== loadKey ? null : { ...current, index: current.index - 1 })} type="button"><PreviousGlyph /></button> : null}
          <img alt={currentImage.alt} src={currentImage.source} title={node.title ?? undefined} />
          {showNext ? <button aria-label="Next image" className="chat-markdown-image-preview__next" onClick={() => setGallery((current) => current?.key !== loadKey ? null : { ...current, index: current.index + 1 })} type="button"><NextGlyph /></button> : null}
        </dialog>
      </>
    );
  };
}
