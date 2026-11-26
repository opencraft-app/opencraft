import { MediaPlayer } from "@opencraft/file-preview-web/media-player";
import { AlarmClockIcon, CheckIcon as Check, ChevronDownIcon as ChevronDown, CopyIcon as Copy, LoadingRingIcon as LoaderCircle } from "@opencraft/design-system-web/action-icons";
import { AvatarImage, IdentityAvatarContext, createDeferredView } from "@opencraft/extension-react";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import { parseLeadingSlashCommand, type UserMessageTimelineBlock } from "@opencraft/chat-core";
import { ImagePreview, WebUserMessageDocument, resolveStandardChatResource, writeTextToClipboard } from "@opencraft/chat-render-web";
import { AlertIcon as AlertCircle, CircleIcon as Circle, TextFileIcon as FileText, ImageIcon, LightningIcon, MessageIcon as MessageSquare, ToolIcon as Wrench, PersonIcon as UserRound } from "@opencraft/design-system-web/action-icons";
import { isTouchInteraction } from "@opencraft/design-system-web/input-presentation";
import {
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { useConversationMediaSource } from "./conversation-media-source";
import { usePreviewImageEdit } from "./use-preview-image-edit";
import { MessageTimestamp } from "./message-timestamp";
import { ConversationDocumentContext } from "./document-context";
import { deriveUserMessageWebLayout } from "./user-message-layout";
import { useWebUserMessageCollapse } from "./use-web-user-message-collapse";
const SubmissionRecoveryNotice = createDeferredView(async () => (await import('../submission-recovery-notice')).SubmissionRecoveryNotice);

import "./scheduled-user-message.scss";
import { useLayoutEffect } from "react";
import { ConversationEntryMotionContext } from "./entry-motion";
// Kept out of the startup bundle; a message sent before it loads simply
// appears without the flight.
let sendFlight: typeof import("./send-flight") | null = null;
if (typeof window !== "undefined") void import("./send-flight").then(module => { module.installSendFlight(); sendFlight = module; }).catch(() => undefined);

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
  const intl = useIntl();
  // Existing engines persist this exact leading line; keep the stored/copy text intact.
  const scheduledPrefix = /^\[Scheduled task\]\r?\n/u.exec(block.message);
  const message = scheduledPrefix ? block.message.slice(scheduledPrefix[0].length) : block.message;
  const scheduledLabel = intl.formatMessage({ id: "schedules.title", defaultMessage: "Scheduled task" });
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
          {scheduledPrefix ? <div className="thread-user-message__scheduled" title={scheduledLabel}>
            <AlarmClockIcon size={18} aria-label={scheduledLabel} />
          </div> : null}
          <WebUserMessageDocument
            conversationId={documentContext.conversationId}
            cwd={documentContext.cwd}
            documentId={`${block.id}:user-message`}
            hostId={documentContext.hostId}
            onMeasurementRequest={documentContext.onMeasurementRequest}
            onOpenResource={documentContext.onOpenResource}
            source={message}
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
          <span>{collapseState === "expanded" ? <FormattedMessage id="chat.message.showLess" defaultMessage="Show less" /> : <FormattedMessage id="chat.message.showMore" defaultMessage="Show more" />}</span>
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
  readonly onOpen: (trigger: HTMLButtonElement) => void;
  readonly source: string;
}) {
  const intl = useIntl();
  const documentContext = useContext(ConversationDocumentContext);
  const media = useConversationMediaSource(
    source,
    documentId,
    local ? documentContext.resolveImageSource : undefined,
  );
  return (
    <button
      aria-label={intl.formatMessage({ id: "chat.image.open", defaultMessage: "Open attached image" })}
      className="thread-user-message__image"
      data-state={media.status}
      onClick={(event) => onOpen(event.currentTarget)}
      type="button"
    >
      {media.source === null
        ? media.status === "loading"
          ? <LoaderCircle aria-hidden="true" className="is-spinning" size={20} />
          : <ImageIcon aria-hidden="true" size={20} />
        : <img
            alt={intl.formatMessage({ id: "chat.image.attachment", defaultMessage: "User attachment" })}
            onLoad={() => media.requestMeasurement("image-load")}
            src={media.source}
          />}
    </button>
  );
}

function UserMessageImageViewer({
  documentId,
  imageCount,
  index,
  local,
  onClose,
  onNext,
  onPrevious,
  returnFocus,
  source,
  previous,
  next,
}: {
  readonly documentId: string;
  readonly imageCount: number;
  readonly index: number;
  readonly local: boolean;
  readonly onClose: () => void;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
  readonly returnFocus: () => HTMLElement | null;
  readonly source: string;
  readonly previous?: { source: string; local: boolean };
  readonly next?: { source: string; local: boolean };
}) {
  const intl = useIntl();
  const documentContext = useContext(ConversationDocumentContext);
  const media = useConversationMediaSource(source, documentId, local ? documentContext.resolveImageSource : undefined);
  const imageEdit = usePreviewImageEdit(media.source, "image.png", onClose);
  const label = intl.formatMessage({ id: "chat.image.position", defaultMessage: "Attached image {index} of {count}" }, { index: index + 1, count: imageCount });
  if (imageEdit.editor) return imageEdit.editor;
  return <ImagePreview className="thread-user-image-lightbox" image={{ id: documentId, source: media.source, alt: label, status: media.status === "loading" ? "loading" : "unavailable" }}
    onClose={onClose} returnFocus={returnFocus} actions={imageEdit.action} position={{ index, count: imageCount }}
    previous={imageCount > 1 ? { onSelect: onPrevious, content: previous ? <UserMessageImageNeighbor {...previous} documentId={`${documentId}:previous`} /> : undefined } : undefined}
    next={imageCount > 1 ? { onSelect: onNext, content: next ? <UserMessageImageNeighbor {...next} documentId={`${documentId}:next`} /> : undefined } : undefined} />;
}

function UserMessageImageNeighbor({ source, local, documentId }: { source: string; local: boolean; documentId: string }) {
  const context = useContext(ConversationDocumentContext);
  const media = useConversationMediaSource(source, documentId, local ? context.resolveImageSource : undefined);
  return media.source ? <img alt="" draggable={false} src={media.source} /> : null;
}

function UserMessageAttachmentRows({ block }: { readonly block: UserMessageTimelineBlock }) {
  const intl = useIntl();
  const documentContext = useContext(ConversationDocumentContext);
  const { images, audio, contexts, files, mcpContexts } = deriveUserMessageWebLayout(block);
  // History hydration may reorder images. Identity follows the locator, not its
  // current position, so mounted reads, keyboard focus and the viewer survive.
  const occurrences = new Map<string, number>();
  const imageIds = images.map(part => {
    const occurrence = occurrences.get(part.source) ?? 0;
    occurrences.set(part.source, occurrence + 1);
    return JSON.stringify([block.id, "user-attachment", part.source, occurrence]);
  });
  const [expandedImageId, setExpandedImageId] = useState<string | null>(null);
  const expandedImageIndex = expandedImageId === null ? -1 : imageIds.indexOf(expandedImageId);
  const imageTriggerRef = useRef<HTMLButtonElement | null>(null);
  const nextImage = () => setExpandedImageId(imageIds[(expandedImageIndex + 1) % images.length] ?? null);
  const previousImage = () => setExpandedImageId(imageIds[(expandedImageIndex + images.length - 1) % images.length] ?? null);
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
                documentId={imageIds[index]}
                key={imageIds[index]}
                local={part.type === "local-image"}
                onOpen={(trigger) => { imageTriggerRef.current = trigger; setExpandedImageId(imageIds[index]); }}
                source={part.source}
              />
            ))}
          </div>
        </div>
      )}
      {expandedImageIndex < 0 || images[expandedImageIndex] === undefined ? null : (
        <UserMessageImageViewer
          documentId={`${expandedImageId}:viewer`}
          imageCount={images.length}
          index={expandedImageIndex}
          local={images[expandedImageIndex].type === "local-image"}
          onClose={() => setExpandedImageId(null)}
          onNext={nextImage}
          onPrevious={previousImage}
          returnFocus={() => imageTriggerRef.current}
          source={images[expandedImageIndex].source}
          previous={images.length > 1 ? { source: images[(expandedImageIndex + images.length - 1) % images.length]!.source, local: images[(expandedImageIndex + images.length - 1) % images.length]!.type === "local-image" } : undefined}
          next={images.length > 1 ? { source: images[(expandedImageIndex + 1) % images.length]!.source, local: images[(expandedImageIndex + 1) % images.length]!.type === "local-image" } : undefined}
        />
      )}
      {audio.length === 0 && files.length === 0 ? null : (
        <div className="thread-user-message__file-attachments" data-user-message-file-row="">
          {audio.map((part, index) => {
            const source = part.type === "local-audio" ? documentContext.resolveImageSource?.(part.source) ?? null : part.source;
            return source === null
              ? <button className="thread-user-message__chip" key={`${part.type}:${part.source}:${index}`} onClick={() => openPath(part.source)} type="button"><FormattedMessage id="chat.attachment.audio" defaultMessage="Audio" /></button>
              : <MediaPlayer kind="audio" key={`${part.type}:${part.source}:${index}`} source={source} />;
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
                    ? intl.formatMessage({ id: "chat.attachment.line", defaultMessage: "Line {line}" }, { line: attachment.startLine })
                    : intl.formatMessage({ id: "chat.attachment.lines", defaultMessage: "Lines {start}–{end}" }, { start: attachment.startLine, end: attachment.endLine })}</small>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
      {contexts.length === 0 && mcpContexts.length === 0 && !block.referencesPriorConversation ? null : (
        <div className="thread-user-message__context-scroll" data-user-message-context-row="">
          <div className="thread-user-message__context-row">
            {block.referencesPriorConversation ? <span className="thread-user-message__chip"><MessageSquare aria-hidden="true" size={13} /><FormattedMessage id="chat.message.previousContext" defaultMessage="Previous context" /></span> : null}
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

function UserMessageStatusRow({ block, hookStatsAccessory }: {
  readonly block: UserMessageTimelineBlock;
  readonly hookStatsAccessory?: ReactNode;
}) {
  const chips: ReactNode[] = [];
  const recovery = useContext(ConversationDocumentContext).submissionRecovery;
  const submission = block.clientId === null ? undefined : recovery?.byClientId.get(block.clientId);
  const input = block.steerEvidence;
  const slashCommand = block.goal ? null : parseLeadingSlashCommand(block.message);
  if (submission && recovery) {
    chips.push(<SubmissionRecoveryNotice key={submission.commandId} submission={submission}
      onAbandon={recovery.onAbandon} onRetry={recovery.onRetry} />);
  } else if (block.inputDelivery && block.inputDelivery.context === 'unobserved') {
    chips.push(<span data-status-kind="execution-ended" key="input-ended"><Check aria-hidden="true" size={11} />
      {block.inputDelivery.execution === 'running' || block.inputDelivery.execution === 'unbound'
        ? <FormattedMessage id="chat.message.received" defaultMessage="Received" />
        : block.inputDelivery.execution === 'interrupted'
        ? <FormattedMessage id="chat.message.turnStopped" defaultMessage="Received; turn stopped" />
        : <FormattedMessage id="chat.message.turnEnded" defaultMessage="Received; turn ended" />}
    </span>);
  } else if (input) {
    const confirmed = input.evidence.value === 'context-confirmed';
    chips.push(<span data-status-kind={confirmed ? 'context-confirmed' : input.admission.value} key="input-evidence">
      {confirmed ? <Check aria-hidden="true" size={11} /> : <Circle aria-hidden="true" size={8} />}
      {confirmed ? <FormattedMessage id="chat.steerEvidence.contextConfirmed" defaultMessage="Input confirmed in task context" />
        : input.admission.value === 'accepted' ? <FormattedMessage id="chat.steerEvidence.accepted" defaultMessage="Accepted; context not yet confirmed" />
        : input.admission.value === 'rejected' || input.admission.value === 'failed' ? <FormattedMessage id="chat.steerEvidence.rejected" defaultMessage="Input rejected" />
        : <FormattedMessage id="chat.steerEvidence.unconfirmed" defaultMessage="Delivery unconfirmed" />}
    </span>);
  }
  if (!submission && !input && !block.inputDelivery && block.deliveryStatus === "not-sent") chips.push(<span data-status-kind="hook-blocked" key="hook-blocked"><AlertCircle aria-hidden="true" size={11} /><FormattedMessage id="chat.message.hookBlocked" defaultMessage="Hook blocked this message" /></span>);
  else if (!submission && !input && !block.inputDelivery && block.deliveryStatus === "failed") chips.push(<span data-status-kind="failed" key="failed"><AlertCircle aria-hidden="true" size={11} /><FormattedMessage id="chat.message.notSent" defaultMessage="Not sent" /></span>);
  else if (!submission && !input && !block.inputDelivery && block.deliveryStatus === "unknown") chips.push(<span data-status-kind="unknown" key="unknown"><Circle aria-hidden="true" size={8} /><FormattedMessage id="chat.message.unconfirmed" defaultMessage="Delivery unconfirmed" /></span>);
  else if (block.goal) chips.push(<span data-status-kind="goal" key="goal"><Circle aria-hidden="true" size={8} /><FormattedMessage id="chat.message.goal" defaultMessage="Sent as goal" /></span>);
  else if (slashCommand !== null && (block.deliveryStatus === null || block.deliveryStatus === "sent") && block.messageKind !== "steering") chips.push(<span data-status-kind="command" key="command"><LightningIcon aria-hidden="true" size={11} /><FormattedMessage id="chat.message.slashCommand" defaultMessage="Command /{name}" values={{ name: slashCommand.name }} /></span>);
  else if (block.hookFeedback) chips.push(<span data-status-kind="hook-feedback" key="hook-feedback"><Wrench aria-hidden="true" size={11} /><FormattedMessage id="chat.message.hookFeedback" defaultMessage="Hook feedback" /></span>);
  if (block.reviewMode) chips.push(<span key="review"><FormattedMessage id="chat.message.reviewMode" defaultMessage="Review mode" /></span>);
  if (block.pullRequestFixMode) chips.push(<span key="pr-fix"><FormattedMessage id="chat.message.prFix" defaultMessage="PR fix" /></span>);
  if (block.autoResolveSync) chips.push(<span key="auto-resolve"><FormattedMessage id="chat.message.autoResolve" defaultMessage="Auto resolve conflicts" /></span>);
  if (block.commentCount > 0) chips.push(<span key="comments"><FormattedMessage id="chat.message.comments" defaultMessage="{count, plural, one {# comment} other {# comments}}" values={{ count: block.commentCount }} /></span>);
  if (chips.length === 0 && hookStatsAccessory === undefined) return null;
  return <div className="thread-user-message__status-row" aria-live={block.messageKind === "steering" ? "polite" : undefined}>{chips}{hookStatsAccessory}</div>;
}

export function UserMessageBlock({ block, hookStatsAccessory }: {
  readonly block: UserMessageTimelineBlock;
  readonly hookStatsAccessory?: ReactNode;
}) {
  const intl = useIntl();
  const avatars = useContext(IdentityAvatarContext);
  const contact = block.sender ? avatars?.contactLink?.(block.sender.kind, block.sender.loginName) : null;
  const layout = deriveUserMessageWebLayout(block);
  const slashCommand = block.goal ? null : parseLeadingSlashCommand(block.message);
  const allowEntryMotion = useContext(ConversationEntryMotionContext);
  const bubbleRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Only live insertions move; history, reconnect and remounts stay still.
    if (!allowEntryMotion || !bubbleRef.current || !sendFlight) return;
    sendFlight.playSendFlight(bubbleRef.current, sendFlight.takeSendOrigin(block.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
    <div
      ref={bubbleRef}
      className="thread-user-message"
      data-message-kind={block.messageKind}
      tabIndex={layout.hasText ? -1 : undefined}
      onClick={event => {
        // Touch has no hover: focus the message after a plain-text tap. Native
        // focus then owns disclosure and dismissal, including taps elsewhere.
        // The current modality describes this click; a mouse click on a
        // touch-capable laptop keeps hover disclosure.
        if (!layout.hasText || !isTouchInteraction(event.currentTarget.ownerDocument)) return;
        const target = event.target;
        if (!(target instanceof Element) || target.closest(USER_MESSAGE_INTERACTIVE_SELECTOR)) return;
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) return;
        event.currentTarget.focus({ preventScroll: true });
      }}
    >
      <h4 className="thread-role-heading"><FormattedMessage id="chat.message.youSaid" defaultMessage="You said:" /></h4>
      {block.sender?.kind === "employee" && block.sender.loginName ? (
        <div className="thread-user-message__sender">{contact ? <a className="thread-user-message__sender-avatar" href={contact.href} title={contact.label} aria-label={contact.label} target="_blank" rel="noopener noreferrer"><AvatarImage src={avatars?.resolve(block.sender.kind, block.sender.loginName) ?? null} fallback={<UserRound size={12} />} /></a> : <span className="thread-user-message__sender-avatar" aria-hidden="true"><AvatarImage src={avatars?.resolve(block.sender.kind, block.sender.loginName) ?? null} fallback={<UserRound size={12} />} /></span>}<span>{block.sender.loginName}</span></div>
      ) : null}
      <UserMessageAttachmentRows block={block} />
      {layout.showBody ? (
        <div className="thread-user-message__body" data-user-message-body="">
          {layout.showBubble ? (
            <div className={layout.hasText ? "thread-user-message__bubble" : "thread-user-message__bubble is-empty"} data-user-message-bubble="">
              {slashCommand !== null ? (
                <div className="thread-user-message__command-content">
                  <span className="thread-user-message__command-pill" data-command={slashCommand.name.toLowerCase()}>
                    /{slashCommand.name}
                  </span>
                  {slashCommand.args ? <CollapsibleUserMessageText block={{ ...block, message: slashCommand.args }} /> : null}
                </div>
              ) : layout.hasText ? (
                <CollapsibleUserMessageText block={block} />
              ) : (
                <span className="thread-user-message__no-content"><FormattedMessage id="chat.message.noContent" defaultMessage="(No content)" /></span>
              )}
            </div>
          ) : null}
          <div className="thread-user-message__accessories">
            <UserMessageStatusRow block={block} hookStatsAccessory={hookStatsAccessory} />
            {layout.hasText ? <div className="thread-user-message__actions">
              <MessageTimestamp sentAtMs={block.sentAtMs} />
              <button aria-label={copied ? intl.formatMessage({ id: "common.copied", defaultMessage: "Copied" }) : intl.formatMessage({ id: "chat.message.copy", defaultMessage: "Copy message" })} disabled={copied} onClick={copy} title={copied ? intl.formatMessage({ id: "common.copied", defaultMessage: "Copied" }) : intl.formatMessage({ id: "chat.message.copy", defaultMessage: "Copy message" })} type="button">{copied ? <Check aria-hidden="true" size={13} /> : <Copy aria-hidden="true" size={13} />}</button>
            </div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
