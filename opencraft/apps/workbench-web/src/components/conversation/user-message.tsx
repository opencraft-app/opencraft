import type { UserMessageTimelineBlock } from "@opencraft/chat-core";
import { WebUserMessageDocument, resolveStandardChatResource, writeTextToClipboard } from "@opencraft/chat-render-web";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Circle,
  Copy,
  FileText,
  ImageIcon,
  LoaderCircle,
  MessageSquare,
  Wrench,
} from "lucide-react";
import {
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { useConversationMediaSource } from "./conversation-media-source";
import { ConversationDocumentContext } from "./document-context";
import { deriveUserMessageWebLayout } from "./user-message-layout";
import { useWebUserMessageCollapse } from "./use-web-user-message-collapse";

const USER_MESSAGE_COLLAPSED_LINE_COUNT = 20;
const USER_MESSAGE_INTERACTIVE_SELECTOR = "a[href], area[href], button, input, select, textarea, summary, audio[controls], video[controls], iframe, [contenteditable]:not([contenteditable='false']), [tabindex]:not([tabindex='-1'])";

function setInteractiveVisibility(element: HTMLElement, visible: boolean, previousAriaHidden: string | null): void {
  element.toggleAttribute("inert", !visible);
  if (!visible) {
    element.setAttribute("aria-hidden", "true");
  } else if (previousAriaHidden === null) {
    element.removeAttribute("aria-hidden");
  } else {
    element.setAttribute("aria-hidden", previousAriaHidden);
  }
}

function CollapsibleUserMessageText({ block }: { readonly block: UserMessageTimelineBlock }) {
  const documentContext = useContext(ConversationDocumentContext);
  const {
    clipRef,
    collapseState,
    collapsedMaxHeight,
    contentRef,
    toggleExpansion,
  } = useWebUserMessageCollapse({
    collapsedLineCount: USER_MESSAGE_COLLAPSED_LINE_COUNT,
    contentIdentity: block.message,
  });
  const collapsed = collapseState === "collapsed";

  useEffect(() => {
    if (!collapsed) return;
    const clip = clipRef.current;
    if (clip === null) return;
    const previous = new Map<HTMLElement, string | null>();
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        setInteractiveVisibility(element, entry.isIntersecting && entry.intersectionRatio >= 1, previous.get(element) ?? null);
      }
    }, { root: clip, rootMargin: "0px", threshold: 1 });
    const synchronize = () => {
      for (const element of previous.keys()) {
        if (!clip.contains(element)) {
          observer?.unobserve(element);
          previous.delete(element);
        }
      }
      for (const element of clip.querySelectorAll<HTMLElement>(USER_MESSAGE_INTERACTIVE_SELECTOR)) {
        if (previous.has(element) || element.hasAttribute("inert")) continue;
        previous.set(element, element.getAttribute("aria-hidden"));
        if (observer === null) {
          const elementRect = element.getBoundingClientRect();
          const clipRect = clip.getBoundingClientRect();
          setInteractiveVisibility(element, elementRect.top >= clipRect.top && elementRect.right <= clipRect.right && elementRect.bottom <= clipRect.bottom && elementRect.left >= clipRect.left, previous.get(element) ?? null);
        } else {
          observer.observe(element);
        }
      }
    };
    synchronize();
    const mutation = new MutationObserver(synchronize);
    mutation.observe(clip, { childList: true, subtree: true });
    return () => {
      observer?.disconnect();
      mutation.disconnect();
      for (const [element, ariaHidden] of previous) setInteractiveVisibility(element, true, ariaHidden);
    };
  }, [collapsed]);

  return (
    <div className="thread-user-message__collapsible" data-collapse-state={collapseState}>
      <div
        className={collapsed ? "thread-user-message__clip is-collapsed" : "thread-user-message__clip"}
        ref={clipRef}
        style={collapsed && collapsedMaxHeight !== null ? { maxHeight: `${collapsedMaxHeight}px` } : undefined}
      >
        <div ref={contentRef}>
          <WebUserMessageDocument
            conversationId={documentContext.conversationId}
            cwd={documentContext.cwd}
            documentId={`${block.id}:user-message`}
            hostId={documentContext.hostId}
            onMeasurementRequest={documentContext.onMeasurementRequest}
            onOpenResource={documentContext.onOpenResource}
            source={block.message}
            theme={documentContext.theme}
          />
        </div>
      </div>
      {collapsed ? <span aria-hidden="true" className="thread-user-message__ellipsis">…</span> : null}
      {collapseState === "uncollapsible" ? null : (
        <button
          aria-expanded={collapseState === "expanded"}
          className="thread-user-message__expansion"
          onClick={toggleExpansion}
          type="button"
        >
          <span>{collapseState === "expanded" ? "Show less" : "Show more"}</span>
          <ChevronDown aria-hidden="true" className={collapseState === "expanded" ? "is-expanded" : undefined} size={11} />
        </button>
      )}
    </div>
  );
}

function UserMessageImage({
  documentId,
  local,
  onOpen,
  source,
}: {
  readonly documentId: string;
  readonly local: boolean;
  readonly onOpen: () => void;
  readonly source: string;
}) {
  const documentContext = useContext(ConversationDocumentContext);
  const media = useConversationMediaSource(
    source,
    documentId,
    local ? documentContext.resolveImageSource : undefined,
  );
  return (
    <button
      aria-label="Open attached image"
      className="thread-user-message__image"
      data-state={media.status}
      onClick={onOpen}
      type="button"
    >
      {media.source === null
        ? media.status === "loading"
          ? <LoaderCircle aria-hidden="true" className="is-spinning" size={20} />
          : <ImageIcon aria-hidden="true" size={20} />
        : <img
            alt="User attachment"
            onLoad={() => media.requestMeasurement("image-load")}
            src={media.source}
          />}
    </button>
  );
}

function UserMessageAttachmentRows({ block }: { readonly block: UserMessageTimelineBlock }) {
  const documentContext = useContext(ConversationDocumentContext);
  const { images, audio, contexts, files, mcpContexts } = deriveUserMessageWebLayout(block);
  if (images.length === 0 && audio.length === 0 && contexts.length === 0 && files.length === 0 && mcpContexts.length === 0 && !block.referencesPriorConversation) return null;
  const openPath = (path: string) => {
    const decision = resolveStandardChatResource(path, { cwd: documentContext.cwd, externalResourcePolicy: "allow" });
    if (decision.allowed && decision.target !== null) documentContext.onOpenResource?.(decision.target, decision);
  };
  return (
    <>
      {images.length === 0 ? null : (
        <div className="thread-user-message__image-scroll" data-user-message-image-row="">
          <div className="thread-user-message__image-row">
            {images.map((part, index) => (
              <UserMessageImage
                documentId={`${block.id}:user-attachment:${index}`}
                key={`${part.type}:${part.source}:${index}`}
                local={part.type === "local-image"}
                onOpen={() => openPath(part.source)}
                source={part.source}
              />
            ))}
          </div>
        </div>
      )}
      {audio.length === 0 && files.length === 0 ? null : (
        <div className="thread-user-message__file-attachments" data-user-message-file-row="">
          {audio.map((part, index) => {
            const source = part.type === "local-audio" ? documentContext.resolveImageSource?.(part.source) ?? null : part.source;
            return source === null
              ? <button className="thread-user-message__chip" key={`${part.type}:${part.source}:${index}`} onClick={() => openPath(part.source)} type="button">Audio</button>
              : <audio controls key={`${part.type}:${part.source}:${index}`} preload="metadata" src={source} />;
          })}
          {files.map((attachment) => (
            <button
              className="thread-user-message__file-attachment"
              disabled={attachment.target === null}
              key={attachment.id}
              onClick={attachment.target === null ? undefined : () => openPath(attachment.target!)}
              type="button"
            >
              <FileText aria-hidden="true" size={16} />
              <span>
                <strong>{attachment.name}</strong>
                {attachment.startLine === null ? null : (
                  <small>{attachment.endLine === null || attachment.endLine === attachment.startLine
                    ? `Line ${attachment.startLine}`
                    : `Lines ${attachment.startLine}–${attachment.endLine}`}</small>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
      {contexts.length === 0 && mcpContexts.length === 0 && !block.referencesPriorConversation ? null : (
        <div className="thread-user-message__context-scroll" data-user-message-context-row="">
          <div className="thread-user-message__context-row">
            {block.referencesPriorConversation ? <span className="thread-user-message__chip"><MessageSquare aria-hidden="true" size={13} />Previous context</span> : null}
            {contexts.map((part, index) => (
              <button className="thread-user-message__chip" key={`${part.type}:${part.path}:${index}`} onClick={() => openPath(part.path)} type="button">
                {part.type === "mention" ? "@" : "/"}{part.name}
              </button>
            ))}
            {mcpContexts.map((attachment) => attachment.target === null ? (
              <span className="thread-user-message__chip" key={attachment.id}>{attachment.label}</span>
            ) : (
              <button className="thread-user-message__chip" key={attachment.id} onClick={() => openPath(attachment.target!)} type="button">
                {attachment.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function formatUserMessageTimestamp(sentAtMs: number, nowMs = Date.now()): string {
  const sent = new Date(sentAtMs);
  const now = new Date(nowMs);
  const sentDay = new Date(sent.getFullYear(), sent.getMonth(), sent.getDate());
  const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayOffset = Math.round((sentDay.getTime() - nowDay.getTime()) / 86_400_000);
  const options: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  if (dayOffset < 0 && dayOffset > -7) options.weekday = "long";
  else if (dayOffset !== 0) {
    options.month = "short";
    options.day = "numeric";
  }
  return new Intl.DateTimeFormat(undefined, options).format(sent);
}

function UserMessageStatusRow({ block, hookStatsAccessory }: {
  readonly block: UserMessageTimelineBlock;
  readonly hookStatsAccessory?: ReactNode;
}) {
  const chips: ReactNode[] = [];
  if (block.deliveryStatus === "not-sent") chips.push(<span data-status-kind="hook-blocked" key="hook-blocked"><AlertCircle aria-hidden="true" size={11} />Hook blocked this message</span>);
  else if (block.deliveryStatus === "sending") chips.push(<span data-status-kind="sending" key="sending"><LoaderCircle aria-hidden="true" className="is-spinning" size={11} />Sending</span>);
  else if (block.deliveryStatus === "failed") chips.push(<span data-status-kind="failed" key="failed"><AlertCircle aria-hidden="true" size={11} />Not sent</span>);
  else if (block.deliveryStatus === "unknown") chips.push(<span data-status-kind="unknown" key="unknown"><AlertCircle aria-hidden="true" size={11} />Delivery unconfirmed</span>);
  else if (block.goal) chips.push(<span data-status-kind="goal" key="goal"><Circle aria-hidden="true" size={8} />Sent as goal</span>);
  else if (block.hookFeedback) chips.push(<span data-status-kind="hook-feedback" key="hook-feedback"><Wrench aria-hidden="true" size={11} />Hook feedback</span>);
  if (block.reviewMode) chips.push(<span key="review">Review mode</span>);
  if (block.pullRequestFixMode) chips.push(<span key="pr-fix">PR fix</span>);
  if (block.autoResolveSync) chips.push(<span key="auto-resolve">Auto resolve conflicts</span>);
  if (block.commentCount > 0) chips.push(<span key="comments">{block.commentCount} {block.commentCount === 1 ? "comment" : "comments"}</span>);
  if (chips.length === 0 && hookStatsAccessory === undefined) return null;
  return <div className="thread-user-message__status-row">{chips}{hookStatsAccessory}</div>;
}

export function UserMessageBlock({ block, hookStatsAccessory }: {
  readonly block: UserMessageTimelineBlock;
  readonly hookStatsAccessory?: ReactNode;
}) {
  const layout = deriveUserMessageWebLayout(block);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
  }, []);
  const copy = () => {
    void writeTextToClipboard(block.message.trim()).then(() => {
      setCopied(true);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1_500);
    }).catch(() => setCopied(false));
  };
  return (
    <div className="thread-user-message" data-message-kind={block.messageKind}>
      <h4 className="thread-role-heading">You said:</h4>
      <UserMessageAttachmentRows block={block} />
      {layout.showBody ? (
        <div className="thread-user-message__body" data-user-message-body="">
          {layout.showBubble ? (
            <div className={layout.hasText ? "thread-user-message__bubble" : "thread-user-message__bubble is-empty"} data-user-message-bubble="">
              {layout.hasText ? <CollapsibleUserMessageText block={block} /> : <span className="thread-user-message__no-content">(No content)</span>}
            </div>
          ) : null}
          <div className="thread-user-message__accessories">
            <UserMessageStatusRow block={block} hookStatsAccessory={hookStatsAccessory} />
            {layout.hasText ? <div className="thread-user-message__actions">
              {block.sentAtMs === null ? null : <time dateTime={new Date(block.sentAtMs).toISOString()}>{formatUserMessageTimestamp(block.sentAtMs)}</time>}
              <button aria-label={copied ? "Copied" : "Copy message"} disabled={copied} onClick={copy} title={copied ? "Copied" : "Copy message"} type="button">{copied ? <Check aria-hidden="true" size={13} /> : <Copy aria-hidden="true" size={13} />}</button>
            </div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
