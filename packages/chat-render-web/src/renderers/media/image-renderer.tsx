import { useIntl } from "@opencraft/i18n/react";
import { CloseIcon as SharedCloseIcon, ChevronLeftIcon as SharedChevronLeftIcon, ChevronRightIcon as SharedChevronRightIcon } from "@opencraft/design-system-web/action-icons";
import { chatMediaPresentationKey, useChatMediaSource, type ChatNodeRendererProps, type ChatResourcePolicyService } from "@opencraft/chat-render-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { usePreviewFocusOrigin } from "../../preview-focus-origin";
import { ZoomableImage } from "../../zoomable-image";
import "./image.scss";

function CloseGlyph() { return <SharedCloseIcon size={16} />; }

function PreviousGlyph() { return <SharedChevronLeftIcon size={16} />; }

function NextGlyph() { return <SharedChevronRightIcon size={16} />; }

interface ImageGalleryState {
  readonly key: string;
  readonly index: number;
  readonly items: readonly { readonly alt: string; readonly source: string }[];
}

export function createImageRenderer(resources: ChatResourcePolicyService) {
  return function ImageRenderer({ node, context }: ChatNodeRendererProps) {
    const intl = useIntl();
    const [gallery, setGallery] = useState<ImageGalleryState | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [mediaState, setMediaState] = useState<{
      readonly key: string;
      readonly source: string | null;
      readonly status: "loading" | "ready" | "unavailable";
    } | null>(null);
    const dialogRef = useRef<HTMLDialogElement>(null);
    const previewFocus = usePreviewFocusOrigin();
    if (node.kind !== "image") return null;
    // anchor policy rejects every data: URL. Keep that exception local to the
    // image renderer so it cannot weaken link navigation safety.
    const standardDecision = /^data:image\//iu.test(node.src)
      ? { allowed: true as const, kind: "external" as const, target: node.src }
      : resources.resolve(node.src, context);
    const hostFile = standardDecision.allowed && standardDecision.kind === "external" && standardDecision.target !== null
      ? context.loadMediaSource?.resolveFileSource?.(standardDecision.target) : null;
    const decision = hostFile ? { allowed: true as const, kind: "file" as const, target: hostFile } : standardDecision;
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
    // Shared consumers retain their subscription while the resource owner
    // invalidates bytes. Only legacy providers need a new request identity.
    const legacyAttempt = context.loadMediaSource?.getSnapshot ? 0 : attempt;
    const request = useMemo(() => !mustLoadThroughHost || decision.target === null ? null : ({
      source: node.src, resolvedTarget: decision.target, resourceKind: decision.kind!,
      documentId: context.documentId, conversationId: context.conversationId ?? null,
      hostId: context.hostId ?? null, cwd: context.cwd ?? null,
    }), [mustLoadThroughHost, decision.target, decision.kind, node.src, context.documentId, context.conversationId, context.hostId, context.cwd, legacyAttempt]);
    const media = useChatMediaSource(context.loadMediaSource, request);
    const sourceKind = /^data:image\//iu.test(node.src) ? "data"
      : decision.kind === "workspace-file" || decision.kind === "file" ? "file"
      : decision.kind === "resource" ? "resource" : decision.kind === "external" ? "external" : "other";
    const reportMedia = (phase: "policy" | "source" | "decode", outcome: "ok" | "failed", error?: unknown) => {
      try { context.onMediaDiagnostic?.({ documentId: context.documentId, phase, outcome, sourceKind,
        transport: mustLoadThroughHost ? "host" : "direct", contentType: media.value?.contentType, readAttempts: media.value?.readAttempts, error }); } catch { /* Diagnostics cannot affect presentation. */ }
    };
    useEffect(() => {
      if (!decision.allowed || decision.target === null) {
        try { context.onMediaDiagnostic?.({ documentId: context.documentId, phase: "policy", outcome: "failed",
          sourceKind, transport: mustLoadThroughHost ? "host" : "direct", policy: "resource" }); } catch { /* Observer isolation. */ }
      }
      else if (!mustLoadThroughHost || media.status !== "loading") {
        reportMedia("source", mustLoadThroughHost && media.status !== "ready" ? "failed" : "ok", media.error);
      }
    }, [context.onMediaDiagnostic, context.documentId, sourceKind, decision.allowed, decision.target, mustLoadThroughHost, media.status, media.error, media.value?.contentType, media.value?.readAttempts]);
    const candidateSource = mustLoadThroughHost ? media.value?.source ?? null : directSource;
    useLayoutEffect(() => {
      if (!candidateSource || !context.onMediaDiagnostic) return;
      const blocked = (event: SecurityPolicyViolationEvent) => {
        if (event.effectiveDirective !== "img-src" || event.disposition !== "enforce"
          || !(event.blockedURI === candidateSource || (["blob", "data"].includes(event.blockedURI) && candidateSource.startsWith(event.blockedURI + ":")))) return;
        try { context.onMediaDiagnostic?.({ documentId: context.documentId, phase: "policy", outcome: "failed",
          sourceKind, transport: mustLoadThroughHost ? "host" : "direct", policy: "csp" }); } catch { /* Observer isolation. */ }
      };
      document.addEventListener("securitypolicyviolation", blocked);
      return () => document.removeEventListener("securitypolicyviolation", blocked);
    }, [candidateSource, context.onMediaDiagnostic, context.documentId, sourceKind, mustLoadThroughHost]);
    const effectiveState = mediaState?.key === loadKey && mediaState.status === "unavailable"
      && mediaState.source === (mustLoadThroughHost ? media.value?.source ?? null : directSource)
      ? mediaState
      : mustLoadThroughHost ? { source: media.value?.source ?? null, status: media.status }
      : { source: directSource, status: directSource ? "ready" : "unavailable" };
    useEffect(() => {
      if (mustLoadThroughHost && media.status !== "loading") context.requestMeasurement?.({ geometryChanged: true, reason: "resource-resolve" });
    }, [media, mustLoadThroughHost, context.requestMeasurement]);
    if (!decision.allowed || decision.target === null) {
      return <span className="chat-markdown-media-unavailable" role="img" title={decision.reason}>{node.alt || intl.formatMessage({ id: "chat.image.unavailable", defaultMessage: "Image unavailable" })}</span>;
    }
    if (effectiveState.status === "loading") {
      return <span aria-label={node.alt || intl.formatMessage({ id: "chat.image.loading", defaultMessage: "Loading image…" })} className="chat-markdown-media-placeholder" data-state="loading" role="img" />;
    }
    if (effectiveState.status === "unavailable" || effectiveState.source === null) {
      const canRetry = !mustLoadThroughHost || !context.loadMediaSource?.getSnapshot || context.loadMediaSource.retry !== undefined;
      return <span className="chat-markdown-media-unavailable"><span role="img" aria-label={node.alt || intl.formatMessage({ id: "chat.image.unavailable", defaultMessage: "Image unavailable" })}>{node.alt || intl.formatMessage({ id: "chat.image.unavailable", defaultMessage: "Image unavailable" })}</span>{canRetry && <button className="chat-markdown-media-retry" type="button" onClick={() => {
        setMediaState(null);
        setAttempt(value => value + 1);
        if (request) void context.loadMediaSource?.retry?.(request).catch(() => { /* The shared snapshot retains the failure. */ });
      }}>{intl.formatMessage({ id: "common.retry", defaultMessage: "Try again" })}</button>}</span>;
    }
    const imageSource = effectiveState.source;
    const close = () => setGallery(null);
    const markUnavailable = () => {
      reportMedia("decode", "failed");
      setMediaState({ key: loadKey, source: imageSource, status: "unavailable" });
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
        <button aria-label={node.alt || intl.formatMessage({ id: "chat.image.openPreview", defaultMessage: "Preview image" })} className="chat-markdown-image-button" data-markdown-image-preview-trigger="true" onClick={(event) => { previewFocus.recordOpen(event); openGallery(event.currentTarget); }} onKeyDown={previewFocus.onTriggerKeyDown} onPointerCancel={previewFocus.onTriggerPointerCancel} onPointerDown={previewFocus.onTriggerPointerDown} type="button">
          <img
            key={attempt}
            alt={node.alt}
            className="chat-markdown-image"
            loading="lazy"
            onError={markUnavailable}
            onLoad={() => { reportMedia("decode", "ok"); context.requestMeasurement?.({ geometryChanged: true, reason: "image-load" }); }}
            src={imageSource}
            title={node.title ?? undefined}
          />
        </button>
        <dialog aria-label={currentImage.alt || intl.formatMessage({ id: "chat.image.preview", defaultMessage: "Image preview" })} className="chat-markdown-image-preview" data-opened-by-pointer={previewFocus.openedByPointer || undefined} onCancel={(event) => { event.preventDefault(); close(); }} onClose={close} onKeyDown={(event) => {
          previewFocus.onPreviewKeyDown(event);
          if (activeGallery === null) return;
          if (event.key === "ArrowLeft" && showPrevious) setGallery({ ...activeGallery, index: activeGallery.index - 1 });
          if (event.key === "ArrowRight" && showNext) setGallery({ ...activeGallery, index: activeGallery.index + 1 });
        }} ref={dialogRef}>
          <button aria-label={intl.formatMessage({ id: "chat.image.close", defaultMessage: "Close image preview" })} className="chat-markdown-image-preview__close" onClick={close} type="button"><CloseGlyph /></button>
          {showPrevious ? <button aria-label={intl.formatMessage({ id: "chat.image.previous", defaultMessage: "Previous image" })} className="chat-markdown-image-preview__previous" onClick={() => setGallery((current) => current?.key !== loadKey ? null : { ...current, index: current.index - 1 })} type="button"><PreviousGlyph /></button> : null}
          <ZoomableImage onBackgroundClick={close} key={`${activeGallery !== null}:${activeGallery?.index}`} alt={currentImage.alt} src={currentImage.source} title={node.title ?? undefined} />
          {showNext ? <button aria-label={intl.formatMessage({ id: "chat.image.next", defaultMessage: "Next image" })} className="chat-markdown-image-preview__next" onClick={() => setGallery((current) => current?.key !== loadKey ? null : { ...current, index: current.index + 1 })} type="button"><NextGlyph /></button> : null}
        </dialog>
      </>
    );
  };
}
