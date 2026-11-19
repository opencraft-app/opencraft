import { useChannelMessageActions } from "./channel-message-actions";
import { canForwardMessage } from "./channel-message-transfer";
import { ChannelPicture } from "./channel-picture";
import { useVisibleChannelMentions } from "./channel-mention-visibility";
import { channelComposerPayload, channelMentionRenderer, channelMentionSpans } from "./channel-mentions";
import { ForwardedRecordCard, isRecordMessage } from "./forwarded-record";
import { createConversationScopeLeaseRegistry } from "@opencraft/workbench-runtime/conversation-scope-lease";
import { asConversationScopeId } from "@opencraft/workbench-runtime/conversation-binding";
import { createChannelDisplayCache, type ChannelDisplayCache } from "./channel-display-cache";
import { getChannelRuntime, type ChannelRuntime } from "./channel-runtime";
import { useFilePreviewAvailable } from "@opencraft/file-preview-web";
import { FilePreviewDialog } from "@opencraft/file-preview-web/dialog";
import { downloadBlob } from "@opencraft/design-system-web/download";
import { conversationRecoveryPresentation } from "@opencraft/chat-core";
import { ConversationHistoryStatus } from "@opencraft/chat-render-web/history-presentation";
import {
  openChannelDraftStorage,
  type ChannelDraftPersistence,
  type ChannelDraftAttempt,
} from "./channel-draft-storage";
import type { TrustedExtensionApiV1 } from "@opencraft/extension-runtime";
import { recentGroups } from "./people-directory";
import { channelResource, parseChannelResource } from "./channel-search";
import { combineAbortSignals } from "@opencraft/appserver-client/transport";
import { assistantVisualActivity, AssistantActivity, useAssistantObservation } from "./assistant-activity";
import {
  AssistantCurrentWork,
  ChatSwitcher,
  ChatAvatar,
  ConversationAvatar,
  ChatMenu,
  MessageMenu,
} from "./channel-chat-ui";
import { ChannelGallery, channelGalleryItems, isChannelImage } from "./channel-gallery";
import { ChannelMedia, channelMediaKind } from "./channel-media";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CHANNELS_HOST_ID, type ChannelMessage, type ChannelSummary } from "@opencraft/appserver-protocol";
import { createConversationKey, encodeConversationKey } from "@opencraft/chat-core";
import { MessageTimeline } from "@opencraft/chat-render-web/message-timeline";
import { WebChatDocument } from "@opencraft/chat-render-web";
import {
  createEmptyComposerDocument,
  createClientId,
  createComposerController,
  type ComposerAttachment,
  type ComposerCatalog,
  type ComposerController,
  type ComposerSubmissionAcceptance,
  type SubmitIntent,
} from "@opencraft/composer-core";
import { OpenCraftComposer, type OpenCraftComposerHandle } from "@opencraft/composer-editor";
import { CloseIcon } from "@opencraft/design-system-web/action-icons";
import { Button, IconButton } from "@opencraft/design-system-web/button";
import { NavigationGroup, NavigationItem, NavigationList } from "@opencraft/design-system-web/navigation";
import { useIntl } from "@opencraft/i18n/react";
import type { ExtensionSettingsViewProps } from "@opencraft/extension-react";
import { ImHttpError } from "./client";
import { GroupMembersButton } from "./channel-group-controls";
import { ChannelsClient, type ChannelRpc } from "./channel-client";
import { normalizeChannelAttachment } from "./channel-attachment-file";
import { createChannelPictures, type ChannelPictures } from "./channel-pictures";
import { CHANNEL_ATTACHMENT_LIMIT } from "@opencraft/appserver-protocol";
import "@opencraft/composer-editor/message.web";
import "./channel-chat.scss";

const title = { id: "im.shadow.title", defaultMessage: "Chats" };
const labels = {
  emptyGroups: { id: "im.shadow.emptyGroups", defaultMessage: "No chats yet." },
  emptyMessages: { id: "im.shadow.emptyMessages", defaultMessage: "New messages will appear here." },
  draftSaveFailed: {
    id: "im.channels.draftSaveFailed",
    defaultMessage: "Could not save this draft on this device. Keep this page open to preserve your input.",
  },
  uploading: { id: "im.channels.uploading", defaultMessage: "Uploading attachment… {percent}%" },
  chunkUnavailable: {
    id: "im.channels.chunkUnavailable",
    defaultMessage: "This server needs an update to send large attachments. Your file is still in the draft.",
  },
  reattach: { id: "im.channels.reattach", defaultMessage: "Choose this file again to send it." },
  loading: { id: "im.shadow.loading", defaultMessage: "Loading messages…" },
  stale: { id: "im.shadow.stale", defaultMessage: "Could not refresh messages." },
  denied: { id: "im.shadow.denied", defaultMessage: "This chat is no longer available." },
  earlier: { id: "im.shadow.earlier", defaultMessage: "Load earlier messages" },
  draft: { id: "im.shadow.draft", defaultMessage: "Message for the group" },
  nativeDraft: { id: "im.channels.compose", defaultMessage: "Message" },
  reply: { id: "im.channels.reply", defaultMessage: "Reply" },
  replyTo: { id: "im.channels.replyTo", defaultMessage: "Reply to {name}" },
  cancelReply: { id: "im.channels.cancelReply", defaultMessage: "Cancel reply" },
  mentionUnavailable: {
    id: "im.channels.mentionUnavailable",
    defaultMessage: "A mentioned member has changed or left. Update the mentions and try again.",
  },
  wakeUnavailable: {
    id: "im.channels.wakeUnavailable",
    defaultMessage: "A mentioned bot is no longer available. Update the mentions and try again.",
  },
  tooManyBots: { id: "im.channels.tooManyBots", defaultMessage: "Mention up to eight bots in one message." },
  attachmentFormat: {
    id: "im.channels.attachmentFormat",
    defaultMessage: "Choose a file up to 20 MB with a valid filename.",
  },
  filesUnavailable: {
    id: "im.channels.filesUnavailable",
    defaultMessage: "This external channel does not support file delivery yet. Your file is still in the draft.",
  },
  imageTooLarge: {
    id: "im.channels.imageTooLarge",
    defaultMessage:
      "This external chat accepts images up to 2 MB. Choose a smaller copy; your image is still in the draft.",
  },
  imageInvalid: {
    id: "im.channels.imageInvalid",
    defaultMessage: "This image could not be read. Choose a valid PNG or JPEG copy.",
  },
  imageFormatUnavailable: {
    id: "im.channels.imageFormatUnavailable",
    defaultMessage:
      "This external chat accepts PNG and JPEG images. Choose one of these formats; your image is still in the draft.",
  },
  attachmentPrepareFailed: {
    id: "im.channels.attachmentPrepareFailed",
    defaultMessage: "Could not prepare this file. Choose it again.",
  },
  retryAttachment: { id: "im.channels.retryAttachment", defaultMessage: "Retry download" },
  sendAttachment: { id: "im.channels.sendAttachment", defaultMessage: "Send attachment" },
  sendImage: { id: "im.shadow.sendImage", defaultMessage: "Send image" },
  textTooLong: { id: "im.shadow.textTooLong", defaultMessage: "Group messages can contain up to 4,096 characters." },
  sendFailed: { id: "im.shadow.sendFailed", defaultMessage: "The group message was not sent." },
  unknown: {
    id: "im.shadow.unknown",
    defaultMessage: "Delivery could not be confirmed. Check the group before sending again.",
  },
  opencraft: { id: "im.shadow.opencraft", defaultMessage: "Sent from OpenCraft" },
  you: { id: "im.shadow.you", defaultMessage: "You" },
  previewImage: { id: "im.shadow.previewImage", defaultMessage: "Preview image" },
  closeImage: { id: "im.shadow.closeImage", defaultMessage: "Close image preview" },
  imagePending: { id: "im.shadow.imagePending", defaultMessage: "Loading image…" },
  imageUnavailable: { id: "im.shadow.imageUnavailable", defaultMessage: "Image unavailable." },
  imageFormat: { id: "im.shadow.imageFormat", defaultMessage: "Choose a PNG or JPEG up to 2 MB." },
  imagePartial: {
    id: "im.shadow.imagePartial",
    defaultMessage: "The sender label reached the group. The image was not sent.",
  },
  imageLabelUnknown: {
    id: "im.shadow.imageLabelUnknown",
    defaultMessage: "The image was not sent. Check whether the sender label reached the group.",
  },
} as const;
const sendFailureLabels: Readonly<Record<string, keyof typeof labels>> = {
  channel_chunk_upload_unavailable: "chunkUnavailable",
  channel_image_too_large: "imageTooLarge",
  channel_image_invalid: "imageInvalid",
  channel_image_format_unavailable: "imageFormatUnavailable",
  channel_files_unavailable: "filesUnavailable",
  channel_mention_unavailable: "mentionUnavailable",
  channel_wake_unavailable: "wakeUnavailable",
};
const denied = (error: unknown) => error instanceof ImHttpError && [401, 403].includes(error.status);

type Draft = {
  controller: ComposerController;
  files: Map<string, { file: File; uri: string }>;
  attempt?: ChannelDraftAttempt;
  persistence?: ChannelDraftPersistence;
  persistenceError: boolean;
  persistenceListeners: Set<() => void>;
  updateRetention(): void;
  reply?: { messageId: string; author: string; text: string };
};

function draftStorageFailed(draft: Draft) {
  draft.persistenceError = true;
  for (const listener of draft.persistenceListeners) listener();
}
const resource = channelResource;

function removeFile(draft: Draft, id: string) {
  const previous = draft.files.get(id);
  if (previous) URL.revokeObjectURL(previous.uri);
  draft.files.delete(id);
}

function ChannelFile({
  pictures,
  group,
  message,
  active,
}: {
  pictures: ChannelPictures;
  group: string;
  message: ChannelMessage;
  active: boolean;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const available = useFilePreviewAvailable(message.attachment?.name ?? "");
  const target = useMemo(
    () => ({ group, sequence: message.sequence, kind: "attachment" as const }),
    [group, message.sequence],
  );
  const load = useCallback(
    (signal: AbortSignal) => pictures.resources.read(target, signal).then((value) => value.blob),
    [pictures, target],
  );
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const mime = message.attachment?.type;
  const preview =
    mime !== undefined && isChannelImage(mime)
      ? { group, sequence: message.sequence, kind: "attachment" as const, mime }
      : null;
  async function download() {
    if (busy || !message.attachment) return;
    const owner = new AbortController();
    controller.current = owner;
    setBusy(true);
    setFailed(false);
    try {
      const { blob } = await pictures.resources.read(target, owner.signal);
      if (owner.signal.aborted) return;
      downloadBlob(blob, message.attachment.name);
    } catch {
      if (!owner.signal.aborted) setFailed(true);
    } finally {
      if (!owner.signal.aborted) setBusy(false);
    }
  }
  const media = channelMediaKind(message.attachment?.name ?? "", mime);
  return (
    <>
      {media && (
        <ChannelMedia
          active={active}
          resources={pictures.resources}
          target={target}
          name={message.attachment?.name ?? ""}
          kind={media}
        />
      )}
      {!media && /^(audio|video)\//u.test(mime ?? "") && (
        <small>
          {intl.formatMessage({
            id: "media.unavailable",
            defaultMessage: "Preview unavailable. Download this file to open it.",
          })}
        </small>
      )}
      {open && message.attachment && (
        <FilePreviewDialog
          resource={group + ":" + message.sequence}
          name={message.attachment.name}
          load={load}
          onClose={() => setOpen(false)}
          returnFocus={() => trigger.current}
        />
      )}
      {available && !preview && !media && (
        <Button ref={trigger} variant="secondary" onClick={() => setOpen(true)}>
          {intl.formatMessage({ id: "panel.markdownPreview", defaultMessage: "Preview" })}
        </Button>
      )}
      {preview ? <ChannelPicture pictures={pictures} target={preview} /> : null}
      <Button variant="secondary" disabled={busy} onClick={() => void download()}>
        {failed ? intl.formatMessage(labels.retryAttachment) : message.attachment?.name}
      </Button>
    </>
  );
}

function Picture({ pictures, group, message }: { pictures: ChannelPictures; group: string; message: ChannelMessage }) {
  const state = message.image?.state;
  return (
    <ChannelPicture
      pictures={pictures}
      unavailable={state === "unavailable"}
      target={state === "ready" ? { group, sequence: message.sequence, kind: "image" } : null}
    />
  );
}

function GroupTimeline({
  group,
  client,
  runtime: channelRuntime,
  display,
  pictures,
  draft,
  images,
  groupTools,
  reportError,
  host,
  regions,
  groups,
  focusSequence,
  assistant,
  onSelect,
  directoryCurrent,
  directoryFailed,
  onJumpToMention,
  onDeparted,
}: {
  onJumpToMention(sequence: number): void;
  directoryCurrent: boolean;
  directoryFailed: boolean;
  host: ExtensionSettingsViewProps["host"];
  regions: ExtensionSettingsViewProps["regions"];
  focusSequence?: number;
  onDeparted?(): void;
  groups: ChannelSummary[];
  assistant?: { channelId: string; actorId: string } | null;
  onSelect(group: ChannelSummary): void;
  group: ChannelSummary;
  client: ChannelsClient;
  runtime: ChannelRuntime;
  display: ChannelDisplayCache;
  pictures: ChannelPictures;
  draft: Draft;
  images: boolean;
  groupTools: boolean;
  reportError: ExtensionSettingsViewProps["reportError"];
}) {
  const intl = useIntl();
  const t = (label: keyof typeof labels) => intl.formatMessage(labels[label]);
  const cached = focusSequence ? undefined : display.get(group.id);
  const cursorRef = useRef(cached?.cursor);
  const checkpointRef = useRef(cached?.checkpoint);
  const [messages, setMessages] = useState<ChannelMessage[] | null>(focusSequence ? null : (cached?.messages ?? null));
  const [hasEarlier, setHasEarlier] = useState(cached?.hasEarlier ?? false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // All history reads, including pagination and receipt recovery, share this epoch.
  const historyEpoch = useRef(0);
  function retireHistoryReads() {
    historyEpoch.current++;
    setLoadingEarlier(false);
  }
  const [loadState, setLoadState] = useState<"loading" | "ready" | "stale" | "denied">("loading");
  const historyPresentation = conversationRecoveryPresentation({
    authoritative: loadState === "ready" && directoryCurrent,
    hasVisibleHistory: !!messages?.length,
    failed: loadState === "stale" || directoryFailed,
  });
  const authoritative = loadState === "ready" && directoryCurrent;
  const [reply, setReply] = useState(draft.reply);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const actions = useChannelMessageActions({
    client,
    source: group.id,
    signal: channelRuntime.signal,
    active: authoritative,
  });
  const [menuSequence, setMenuSequence] = useState<number | null>(null);
  const composerHandle = useRef<OpenCraftComposerHandle>(null);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const request = useRef<AbortSignal | null>(null);
  const conversationId = encodeConversationKey(createConversationKey(CHANNELS_HOST_ID, group.id));
  const composer = useSyncExternalStore(
    draft.controller.subscribe,
    draft.controller.getSnapshot,
    draft.controller.getSnapshot,
  );
  const persistenceError = useSyncExternalStore(
    (listener) => {
      draft.persistenceListeners.add(listener);
      return () => {
        draft.persistenceListeners.delete(listener);
      };
    },
    () => draft.persistenceError,
    () => draft.persistenceError,
  );
  const groupActions = groupTools && group.kind === "group";
  const direct = group.kind === "direct";
  const observation = useAssistantObservation(channelRuntime, direct && loadState !== "denied" ? group.id : null);
  const runtime = observation?.runtime ?? null;
  const peer = messages?.find((message) => !message.sender?.isSelf)?.sender;
  const bot = !!observation?.assistant || peer?.actorKind === "session";
  const avatarId = observation?.assistant?.actorId ?? peer?.id ?? group.id;
  const Header = regions?.Header;
  const ComposerActions = regions?.ComposerActions;
  const titleText = observation?.assistant
    ? intl.formatMessage({ id: "im.direct.assistant", defaultMessage: "My assistant" })
    : group.title;
  const openPeople = () => host.openView("opencraft.im.agents");
  const mentionCatalog = useMemo<ComposerCatalog | undefined>(
    () =>
      groupActions
        ? {
            async search(query, signal) {
              if (query.kind !== "mention" || !signal) return [];
              const { members } = await client.members(group.id, signal);
              const term = query.query.toLocaleLowerCase();
              return members
                .filter(
                  (member) =>
                    (member.actorKind === "human" || member.actorKind === "session") &&
                    (member.displayName.toLocaleLowerCase().includes(term) ||
                      member.actorId.toLocaleLowerCase().includes(term)),
                )
                .slice(0, query.limit)
                .map((member) => ({
                  id: member.actorId,
                  kind: "mention",
                  label: member.displayName,
                  detail: [
                    intl.formatMessage(
                      member.actorKind === "human"
                        ? { id: "im.channels.member", defaultMessage: "Member" }
                        : member.canWake
                          ? { id: "im.channels.bot", defaultMessage: "Bot" }
                          : { id: "im.channels.botMentionOnly", defaultMessage: "Bot · reference only; won't start" },
                    ),
                    member.mentionDelivery === "native-only"
                      ? intl.formatMessage({
                          id: "im.channels.nativeOnlyMention",
                          defaultMessage: "Native-only mention",
                        })
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" · "),
                  uri: null,
                  metadata: {
                    mentionKind: member.actorKind === "human" ? "person" : "agent",
                    channelId: group.id,
                    canWake: member.canWake === true,
                    mentionDelivery: member.mentionDelivery,
                  },
                }));
            },
          }
        : undefined,
    [client, group.id, groupActions, intl],
  );

  const mentionPayload = useMemo(
    () => channelComposerPayload(composer.draft.document, group.id),
    [composer.draft.document, group.id],
  );
  const acknowledgeVisibleMention = useCallback(
    (id: string) =>
      setMessages(
        (previous) =>
          previous?.map((message) =>
            message.messageId === id
              ? { ...message, mentions: message.mentions?.map((m) => (m.isSelf ? { ...m, isUnread: false } : m)) }
              : message,
          ) ?? null,
      ),
    [],
  );
  useVisibleChannelMentions({
    viewport,
    messages,
    active: authoritative,
    client,
    channelId: group.id,
    onAcknowledged: acknowledgeVisibleMention,
  });

  function chooseReply(message?: ChannelMessage) {
    if (message && !authoritative) return;
    draft.reply = message?.messageId
      ? {
          messageId: message.messageId,
          author: message.sender?.displayName ?? message.author,
          text: message.text.slice(0, 240),
        }
      : undefined;
    setReply(draft.reply);
    void draft.persistence?.setReply(draft.reply).catch(() => draftStorageFailed(draft));
    composerHandle.current?.focus();
  }

  function merge(page: ChannelMessage[]) {
    setMessages((previous) => {
      const next = new Map(previous?.map((message) => [message.sequence, message]));
      for (const message of page) {
        const old = next.get(message.sequence);
        if (
          old &&
          ((old.revision !== undefined && message.revision !== undefined && old.revision > message.revision) ||
            (old.status !== "sending" && message.status === "sending") ||
            (old.image && old.image.state !== "pending" && message.image?.state === "pending"))
        )
          continue;
        next.set(message.sequence, message);
      }
      return [...next.values()].sort((a, b) => a.sequence - b.sequence);
    });
  }
  useLayoutEffect(() => {
    if (focusSequence) return;
    if (loadState === "denied") {
      display.delete(group.id);
      cursorRef.current = undefined;
      checkpointRef.current = undefined;
    } else if (messages !== null)
      display.put(group.id, { messages, hasEarlier, cursor: cursorRef.current, checkpoint: checkpointRef.current });
  }, [draft, display, group.id, messages, hasEarlier, loadState, focusSequence]);

  useLayoutEffect(() => draft.updateRetention(), [draft, reply, composer.draft]);

  useEffect(() => {
    const owner = new AbortController();

    let cursor = cursorRef.current,
      generation = 0;
    const refresh = async (connection: AbortSignal) => {
      request.current = connection;
      const started = generation;
      if (focusSequence) {
        const page = await client.around(group.id, focusSequence, connection);
        if (connection.aborted || started !== generation) return;
        pictures.restore(group.id);
        setMessages(page.messages);
        setHasEarlier(page.hasEarlier);
        setLoadState("ready");
        return;
      }
      while (!connection.aborted) {
        const page = await client.sync(group.id, cursor, connection);
        if (connection.aborted || started !== generation) return;
        pictures.restore(group.id);
        if (page.kind === "snapshot" && (cursor === undefined || page.cursor !== "")) {
          setMessages(page.messages);
          setHasEarlier(page.hasEarlier);
        } else merge(page.messages);
        cursor = page.cursor;
        cursorRef.current = cursor;
        setLoadState("ready");
        if (page.kind === "snapshot" || !page.hasMore) return;
      }
    };
    client.watch(
      group.id,
      refresh,
      (error) => {
        setMenuSequence(null);
        if (denied(error)) {
          retireHistoryReads();
          setMessages(null);
          draft.reply = undefined;
          setReply(undefined);
          cursor = undefined;
          pictures.revoke(group.id);
          draft.controller.dispatch({ type: "clear" });
          draft.attempt = undefined;
          void draft.persistence?.clear().catch(() => draftStorageFailed(draft));
          setLoadState("denied");
        } else setLoadState("stale");
      },
      owner.signal,
      {
        onConnectionLost: () => {
          generation++;
          request.current = null;
          retireHistoryReads();
          setLoadState("loading");
          setMenuSequence(null);
        },
      },
    );
    return () => owner.abort();
  }, [client, group.id, draft, focusSequence]);

  useEffect(() => {
    const attempt = draft.attempt,
      restoredReply = draft.reply,
      epoch = historyEpoch.current;
    if (!attempt) return;
    const owner = new AbortController();
    const lookup = combineAbortSignals([owner.signal, AbortSignal.timeout(5000)]);
    void client
      .delivery(group.id, attempt.id, lookup.signal)
      .then(({ receipt }) => {
        if (
          lookup.signal.aborted ||
          epoch !== historyEpoch.current ||
          !receipt ||
          !["delivered", "sending"].includes(receipt.status)
        )
          return;
        if (!focusSequence) merge([receipt]);
        if (draft.attempt !== attempt) return;
        if (attempt.attachmentId) {
          const current = draft.controller.getSnapshot().draft;
          if (!current.attachments.some((item) => item.id === attempt.attachmentId)) return;
          draft.attempt = undefined;
          if (attempt.documentAccepted && JSON.stringify(current.document) === attempt.document)
            draft.controller.dispatch({ type: "set-document", document: createEmptyComposerDocument() });
          draft.controller.dispatch({ type: "remove-attachment", id: attempt.attachmentId });
          removeFile(draft, attempt.attachmentId);
          return;
        }
        if (
          draft.reply !== restoredReply ||
          JSON.stringify(draft.controller.getSnapshot().draft.document) !== attempt.document
        )
          return;
        // Read-only reconciliation: clear only the exact saved text, never edits
        // made during lookup or a different pending submission.
        draft.attempt = undefined;
        draft.controller.dispatch({ type: "set-document", document: createEmptyComposerDocument() });
        draft.reply = undefined;
        setReply(undefined);
        void draft.persistence?.setReply(undefined).catch(() => draftStorageFailed(draft));
      })
      .catch(() => {})
      .finally(() => lookup.dispose());
    return () => owner.abort();
  }, [client, group.id, draft]);

  const acknowledgedRead = useRef(0),
    reading = useRef(false);
  function readLatest() {
    const signal = request.current;
    const sequence = messages?.at(-1)?.sequence;
    if (
      focusSequence ||
      !signal ||
      signal.aborted ||
      !sequence ||
      !authoritative ||
      reading.current ||
      acknowledgedRead.current >= sequence
    )
      return;
    reading.current = true;
    void client
      .markRead(group.id, sequence, signal)
      .then(() => {
        if (!signal.aborted) acknowledgedRead.current = sequence;
      })
      .catch(() => {})
      .finally(() => {
        reading.current = false;
      });
  }

  async function earlier() {
    const signal = request.current;
    if (!authoritative || !messages?.length || !signal || loadingEarlier) return;
    const epoch = historyEpoch.current;
    setLoadingEarlier(true);
    try {
      const page = await client.history(group.id, messages[0].sequence, signal);
      if (signal.aborted || epoch !== historyEpoch.current) return;
      merge(page.messages);
      setHasEarlier(page.hasEarlier);
    } catch (error) {
      if (signal.aborted || epoch !== historyEpoch.current) return;
      if (denied(error)) {
        retireHistoryReads();
        setMessages(null);
        setLoadState("denied");
      } else setLoadState("stale");
    } finally {
      if (!signal.aborted && epoch === historyEpoch.current) setLoadingEarlier(false);
    }
  }

  async function resolveAttachment(
    file: File,
    attachment: ComposerAttachment,
    signal?: AbortSignal,
  ): Promise<ComposerAttachment> {
    if (
      file.size > CHANNEL_ATTACHMENT_LIMIT ||
      !file.name ||
      file.name.length > 160 ||
      /[\x00-\x1f\x7f/\\]/u.test(file.name)
    ) {
      return { ...attachment, lifecycle: "failed", error: t("attachmentFormat") };
    }
    try {
      file = await normalizeChannelAttachment(file, signal);
    } catch (error) {
      signal?.throwIfAborted();
      return {
        ...attachment,
        lifecycle: "failed",
        error: t(
          error instanceof Error && error.message === "channel_image_invalid"
            ? "imageInvalid"
            : "attachmentPrepareFailed",
        ),
      };
    }
    signal?.throwIfAborted();
    removeFile(draft, attachment.id);
    const uri = URL.createObjectURL(file);
    draft.files.set(attachment.id, { file, uri });
    return { ...attachment, mimeType: file.type || "application/octet-stream", uri, lifecycle: "ready", error: null };
  }

  async function send(intent: SubmitIntent): Promise<boolean | ComposerSubmissionAcceptance> {
    const signal = request.current;
    if (!group.canSend || !authoritative || !signal || signal.aborted) return false;
    const payload = channelComposerPayload(intent.document, group.id),
      text = payload.text;
    if (!intent.attachments.length && !text.trim()) return false;
    if (text.length > 4096) {
      reportError?.({ key: conversationId, message: t("textTooLong") });
      return false;
    }
    const epoch = historyEpoch.current;
    const quote = draft.reply,
      wakeActorIds = groupActions ? payload.wakeActorIds : [],
      mentions = groupActions ? payload.mentions : [];
    if (mentions.length > 32) {
      reportError?.({
        key: conversationId,
        message: intl.formatMessage({
          id: "im.channels.tooManyMentions",
          defaultMessage: "Mention up to 32 members in one message.",
        }),
      });
      return false;
    }
    if (wakeActorIds.length > 8) {
      reportError?.({ key: conversationId, message: t("tooManyBots") });
      return false;
    }
    const options = {
      ...(quote ? { replyToMessageId: quote.messageId } : {}),
      ...(wakeActorIds.length ? { wakeActorIds } : {}),
      ...(groupActions ? { mentions } : {}),
    };
    const accepted: string[] = [];
    let documentAccepted = false;
    const settlement = (): ComposerSubmissionAcceptance | false =>
      accepted.length ? { status: "accepted", attachmentIds: accepted, documentAccepted } : false;
    try {
      if (draft.persistence) await draft.persistence.flush();
      for (const attachment of intent.attachments) {
        const owned = draft.files.get(attachment.id);
        if (!owned) throw Error("attachment_unavailable");
        // Attachment identity belongs to the captured draft, independent of subsequent typing.
        const id = "file:" + attachment.id;
        const caption =
          group.kind === "direct" && !accepted.length && !quote && !wakeActorIds.length ? text : undefined;
        draft.attempt = {
          id,
          payload: JSON.stringify(["file", id, caption ?? null]),
          document: JSON.stringify(intent.document),
          attachmentId: attachment.id,
          documentAccepted: !!caption?.trim(),
        };
        if (draft.persistence)
          try {
            await draft.persistence.setAttempt(draft.attempt);
          } catch (error) {
            draftStorageFailed(draft);
            throw error;
          }
        const { receipt } = await client.sendChannelAttachment(
          group.id,
          id,
          owned.file,
          signal,
          caption,
          (confirmed, total) => {
            if (!signal.aborted) setUploadProgress(total === 0 ? 100 : Math.floor((confirmed * 100) / total));
          },
        );
        setUploadProgress(null);
        if (signal.aborted) return settlement();
        if (epoch === historyEpoch.current && !focusSequence) merge([receipt]);
        if (receipt.status !== "delivered" && receipt.status !== "sending") return settlement();
        if (draft.persistence)
          try {
            await draft.persistence.acceptAttachment(
              attachment.id,
              caption?.trim() ? JSON.stringify(intent.document) : undefined,
            );
          } catch (error) {
            draftStorageFailed(draft);
            throw error;
          }
        accepted.push(attachment.id);
        if (caption?.trim()) documentAccepted = true;
        if (draft.files.get(attachment.id) === owned) removeFile(draft, attachment.id);
      }
      if (text.trim() && !documentAccepted) {
        const payload = JSON.stringify(["text", text, options]);
        const id = draft.attempt?.payload === payload ? draft.attempt.id : intent.clientMessageId;
        draft.attempt = { payload, id, document: JSON.stringify(intent.document) };
        if (draft.persistence) {
          try {
            await draft.persistence.setAttempt(draft.attempt);
          } catch (error) {
            draftStorageFailed(draft);
            throw error;
          }
        }
        const { receipt } = await client.sendText(group.id, id, text, signal, options);
        if (signal.aborted) return settlement();
        if (epoch === historyEpoch.current && !focusSequence) merge([receipt]);
        if (receipt.status !== "delivered" && receipt.status !== "sending") return settlement();
        draft.attempt = undefined;
        documentAccepted = true;
      }
      if (documentAccepted && draft.reply === quote) {
        draft.reply = undefined;
        setReply(undefined);
        void draft.persistence?.setReply(undefined).catch(() => draftStorageFailed(draft));
      }
      if (focusSequence) onSelect(group);
      return accepted.length ? { status: "accepted", attachmentIds: accepted, documentAccepted } : true;
    } catch (error) {
      if (!signal.aborted && epoch === historyEpoch.current) {
        setUploadProgress(null);
        if (denied(error)) {
          retireHistoryReads();
          setMessages(null);
          setLoadState("denied");
        } else
          reportError?.({
            key: conversationId,
            message: t(
              draft.persistenceError
                ? "draftSaveFailed"
                : error instanceof Error
                  ? (sendFailureLabels[error.message] ?? "unknown")
                  : "unknown",
            ),
          });
      }
      return settlement();
    }
  }

  const entries = useMemo(
    () => [
      {
        timelineKey: "history:" + (messages?.[0]?.sequence ?? "empty"),
        estimatedHeightPx: hasEarlier ? 48 : 1,
        index: -1,
        message: undefined as ChannelMessage | undefined,
        previousAt: undefined as number | undefined,
      },
      ...(messages ?? []).map((message, index) => ({
        timelineKey: "message:" + message.sequence,
        index,
        message,
        previousAt: messages?.[index - 1]?.at,
      })),
      {
        timelineKey: "activity",
        estimatedHeightPx: 1,
        index: -2,
        message: undefined as ChannelMessage | undefined,
        previousAt: undefined as number | undefined,
      },
    ],
    [messages, hasEarlier],
  );
  function renderMessage(message: ChannelMessage, previousAt?: number) {
    const canReply = groupTools && group.canSend && !!message.messageId;
    const menuEnabled = authoritative && (canReply || !!message.text || !!message.attachment);
    return (
      <MessageMenu
        key={message.sequence}
        enabled={menuEnabled}
        copyText={message.attachment && message.text.startsWith("[Attachment:") ? undefined : message.text || undefined}
        onForward={canForwardMessage(message) ? () => actions.begin("forward", message) : undefined}
        onDownload={
          message.attachment || message.image?.state === "ready" ? () => actions.begin("download", message) : undefined
        }
        onCopyImage={
          typeof ClipboardItem !== "undefined" &&
          !!navigator.clipboard?.write &&
          (message.image?.state === "ready" || /^image\/(png|jpeg|webp|gif)$/u.test(message.attachment?.type ?? ""))
            ? () => actions.begin("copyImage", message)
            : undefined
        }
        onShare={
          (message.attachment || message.image?.state === "ready") &&
          typeof navigator.share === "function" &&
          typeof navigator.canShare === "function"
            ? () => actions.begin("share", message)
            : undefined
        }
        open={menuSequence === message.sequence}
        onOpenChange={(open) =>
          setMenuSequence((current) => (open ? message.sequence : current === message.sequence ? null : current))
        }
        onReply={canReply ? () => chooseReply(message) : undefined}
      >
        <div
          role="listitem"
          tabIndex={menuEnabled ? 0 : undefined}
          data-self={message.sender?.isSelf === true}
          data-direct={direct}
          data-search-match={focusSequence === message.sequence}
        >
          {(previousAt === undefined || message.at - previousAt > 300000) && (
            <time className="im-channel-chat__time" dateTime={new Date(message.at).toISOString()}>
              {intl.formatDate(message.at, { month: "short", day: "numeric" })} · {intl.formatTime(message.at)}
            </time>
          )}
          {
            <div className="im-channel-chat__avatar">
              <ChatAvatar
                id={direct && observation?.assistant ? avatarId : (message.sender?.id ?? message.author)}
                label={message.sender?.displayName ?? message.author}
                avatar={message.sender?.avatar}
                bot={message.sender?.actorKind === "session"}
              />
            </div>
          }
          <div
            className="im-channel-chat__message"
            data-record={isRecordMessage(message) || undefined}
            data-image-only={
              (!!message.image &&
                !message.text &&
                !message.replyTo &&
                !message.attachment &&
                message.status !== "rejected" &&
                message.status !== "unknown") ||
              undefined
            }
          >
            {!direct && !message.sender?.isSelf && (
              <div className="im-channel-chat__sender">{message.sender?.displayName ?? message.author}</div>
            )}
            {message.messageId && message.mentions?.some((m) => m.isSelf && m.isUnread) && (
              <small className="im-channel-mention-unread" data-unread-mention-message={message.messageId}>
                {intl.formatMessage({ id: "im.channels.mentionedMe", defaultMessage: "Mentioned you" })}
              </small>
            )}
            {message.replyTo && (
              <blockquote className="im-channel-chat__quote">
                <strong>{message.replyTo.author}</strong>
                <span>{message.replyTo.text}</span>
              </blockquote>
            )}
            {isRecordMessage(message) ? (
              <ForwardedRecordCard
                pictures={pictures}
                key={group.id + ":" + message.sequence}
                message={message}
                active={authoritative}
                group={group.id}
              />
            ) : message.text ? (
              <WebChatDocument
                literalSpans={message.mentions?.length ? channelMentionSpans(message) : undefined}
                renderText={message.mentions?.length ? channelMentionRenderer(message) : undefined}
                dialect={
                  message.sender?.actorKind === "session" && !message.sender.isSelf ? "assistant" : "user-message"
                }
                documentId={`${conversationId}:${message.sequence}`}
                conversationId={conversationId}
                source={message.text}
                externalResourcePolicy="restricted"
              />
            ) : null}
            {message.attachment && !isRecordMessage(message) ? (
              <ChannelFile active={authoritative} pictures={pictures} group={group.id} message={message} />
            ) : null}
            {message.image ? <Picture pictures={pictures} group={group.id} message={message} /> : null}
            {message.status === "rejected" ? (
              <small>
                {t(
                  message.image?.attribution === "delivered"
                    ? "imagePartial"
                    : message.image?.attribution === "unknown"
                      ? "imageLabelUnknown"
                      : "sendFailed",
                )}
              </small>
            ) : null}
            {message.status === "unknown" ? <small>{t("unknown")}</small> : null}
          </div>
        </div>
      </MessageMenu>
    );
  }

  const dock =
    group.canSend && loadState !== "denied" ? (
      <div className="im-channel-chat__dock">
        {group.firstUnreadMentionSequence !== undefined && !!group.mentionUnreadCount && (
          <Button
            variant="secondary"
            disabled={!directoryCurrent}
            onClick={() => onJumpToMention(group.firstUnreadMentionSequence!)}
            aria-label={intl.formatMessage({
              id: "im.channels.jumpUnreadMention",
              defaultMessage: "Next unread mention",
            })}
          >
            {intl.formatMessage(
              { id: "im.channels.unreadMentionCount", defaultMessage: "@ you · {count} unread" },
              { count: group.mentionUnreadCount },
            )}
          </Button>
        )}
        {direct && runtime?.works && <AssistantCurrentWork works={runtime.works} />}
        {uploadProgress !== null && (
          <small role="status">{intl.formatMessage(labels.uploading, { percent: uploadProgress })}</small>
        )}
        {persistenceError && <small role="status">{t("draftSaveFailed")}</small>}
        {mentionPayload.nativeOnlyActorIds.length > 0 && (
          <small role="status">
            {intl.formatMessage({
              id: "im.channels.nativeOnlyMentionHint",
              defaultMessage: "Some mentions stay in this app; the external service has no verified matching account.",
            })}
          </small>
        )}
        {mentionPayload.referenceOnlyBotIds.length > 0 && (
          <small role="status">
            {intl.formatMessage({
              id: "im.channels.botMentionOnlyHint",
              defaultMessage:
                "This mention refers to a bot but won't start it; you don't currently have wake permission or it is unavailable.",
            })}
          </small>
        )}
        <OpenCraftComposer
          ref={composerHandle}
          controller={draft.controller}
          presentation="message"
          isRecovering={historyPresentation.endsWith("-loading")}
          isUnstable={loadState === "stale" || directoryFailed}
          submissionDisabled={!authoritative || !group.canSend}
          placeholderPending={historyPresentation.endsWith("-loading")}
          navigationActions={
            <ChatSwitcher assistant={assistant} groups={groups} selected={group.id} onSelect={onSelect} />
          }
          entryActions={undefined}
          endActions={
            ComposerActions ? (
              <ComposerActions
                controller={draft.controller}
                disabled={composer.draft.lifecycle.phase === "submitting"}
                platform={host.platform}
              />
            ) : undefined
          }
          chromeHeader={
            reply && (
              <div className="im-channel-chat__reply">
                <div className="im-channel-chat__quote">
                  <strong>{intl.formatMessage(labels.replyTo, { name: reply.author })}</strong>
                  <span>{reply.text}</span>
                </div>
                <IconButton aria-label={t("cancelReply")} title={t("cancelReply")} onClick={() => chooseReply()}>
                  <CloseIcon size={16} />
                </IconButton>
              </div>
            )
          }
          placeholder={
            historyPresentation.endsWith("-loading")
              ? intl.formatMessage({ id: "chat.composer.loading", defaultMessage: "Loading…" })
              : intl.formatMessage({ id: "im.direct.compose", defaultMessage: "Message…" })
          }
          modelSelectionPolicy="host-default"
          mentionSuggestionsEnabled={groupActions}
          mentionTarget={groupActions ? "person" : undefined}
          catalog={mentionCatalog}
          isStreaming={false}
          onSubmit={send}
          onCancel={() => {}}
          attachmentsEnabled={images}
          sendLabel={composer.draft.attachments.length ? t("sendAttachment") : undefined}
          onResolveAttachment={images ? resolveAttachment : undefined}
          onRemoveAttachment={(attachment) => removeFile(draft, attachment.id)}
        />
      </div>
    ) : (
      <div className="im-channel-chat__dock im-channel-chat__dock--readonly">
        {group.lifecycle?.state === "dissolved" && (
          <p role="status">
            {intl.formatMessage({
              id: "im.channels.group.lifecycle.readonly",
              defaultMessage: "Group dissolved · Read-only history",
            })}
          </p>
        )}
        <ChatSwitcher assistant={assistant} groups={groups} selected={group.id} onSelect={onSelect} />
      </div>
    );
  const heading = (
    <div className="im-channel-chat__heading">
      <ConversationAvatar
        group={group}
        assistantActorId={direct && observation?.assistant ? avatarId : undefined}
        legacyPeer={direct ? peer : undefined}
        activity={direct ? assistantVisualActivity(runtime) : "rest"}
      />
      <h2>{titleText}</h2>
      {direct && runtime?.phase === "running" && runtime.reception && (
        <span
          className="im-channel-chat__presence"
          role="img"
          aria-label={intl.formatMessage({ id: "im.direct.available", defaultMessage: "Assistant available" })}
        />
      )}
      <div className="im-channel-chat__heading-actions">
        <span role="status">{loadState === "stale" ? t("stale") : null}</span>
        {focusSequence ? (
          <Button variant="secondary" onClick={() => onSelect(group)}>
            {intl.formatMessage({ id: "im.search.latest", defaultMessage: "Latest messages" })}
          </Button>
        ) : direct ? (
          <ChatMenu onSettings={openPeople} />
        ) : null}
        {groupActions && authoritative && (
          <GroupMembersButton
            regions={regions}
            client={client}
            group={group}
            reportError={reportError}
            onRemoved={() => {
              onDeparted?.();
              host.openView("opencraft.im.people");
            }}
          />
        )}
      </div>
    </div>
  );
  return (
    <ChannelGallery pictures={pictures} items={channelGalleryItems(group.id, messages ?? [])} active={authoritative}>
      <section
        tabIndex={-1}
        className="im-channel-chat__conversation"
        data-presentation={direct ? "direct" : "group"}
        aria-label={titleText}
      >
        {actions.dialog}
        {actions.feedback ? (
          <p className="im-message-action-feedback" role="status">
            {actions.feedback}
          </p>
        ) : null}
        {Header ? <Header>{heading}</Header> : <header>{heading}</header>}
        {loadState === "denied" ? (
          <div className="message-timeline-plane">
            <div className="im-channel-chat__timeline">
              <p>{t("denied")}</p>
            </div>
            <div className="thread-scroll-footer message-timeline-dock">{dock}</div>
          </div>
        ) : (
          <MessageTimeline
            historyPresentation={historyPresentation}
            footer={dock}
            latestLabel={intl.formatMessage({ id: "chat.backToLatest", defaultMessage: "Back to latest" })}
            className="im-channel-chat__timeline"
            label={titleText}
            entries={entries}
            retainedKeys={menuSequence === null ? [] : ["message:" + menuSequence]}
            revealKey={focusSequence ? "message:" + focusSequence : undefined}
            checkpoint={focusSequence ? undefined : checkpointRef.current}
            onCheckpoint={(value) => {
              if (!focusSequence) {
                checkpointRef.current = value;
                display.checkpoint(group.id, value, messages?.length ?? 0);
              }
            }}
            onViewport={setViewport}
            onReadLatest={readLatest}
            onLoadEarlier={() => {
              if (hasEarlier) void earlier();
            }}
            renderEntry={(entry) =>
              entry.index === -1 ? (
                <div className="im-channel-chat__history">
                  {hasEarlier && (
                    <Button loading={loadingEarlier} variant="secondary" onClick={() => void earlier()}>
                      {t("earlier")}
                    </Button>
                  )}
                  {messages === null ? (
                    <ConversationHistoryStatus presentation={historyPresentation}>
                      {loadState === "stale" ? t("stale") : null}
                    </ConversationHistoryStatus>
                  ) : messages.length === 0 && authoritative ? (
                    <p>{t("emptyMessages")}</p>
                  ) : null}
                </div>
              ) : entry.index === -2 ? (
                <>{direct && authoritative && <AssistantActivity runtime={runtime} avatarId={avatarId} />}</>
              ) : (
                renderMessage(entry.message!, entry.previousAt)
              )
            }
          />
        )}
      </section>
    </ChannelGallery>
  );
}

function PendingChannelConversation({
  title,
  regions,
  failed = false,
  denied = false,
}: {
  title: string;
  regions: ExtensionSettingsViewProps["regions"];
  failed?: boolean;
  denied?: boolean;
}) {
  const intl = useIntl(),
    Header = regions?.Header;
  const heading = (
    <div className="im-channel-chat__heading">
      <ChatAvatar id={title} label={title} />
      <h2>{title}</h2>
    </div>
  );
  return (
    <section className="im-channel-chat__conversation" aria-label={title}>
      {Header ? <Header>{heading}</Header> : <header>{heading}</header>}
      <div className="message-timeline-plane">
        <div className="im-channel-chat__timeline">
          <ConversationHistoryStatus presentation={denied ? "cold-error" : failed ? "cold-error" : "cold-loading"}>
            {denied ? intl.formatMessage(labels.denied) : failed ? intl.formatMessage(labels.stale) : null}
          </ConversationHistoryStatus>
        </div>
      </div>
    </section>
  );
}

export function createChannelChatViews(
  fetcher: typeof fetch,
  images: boolean,
  rpc: ChannelRpc,
  viewId: string,
  activationSignal: AbortSignal,
  groupTools: boolean,
  storage?: TrustedExtensionApiV1["storage"],
  blobs?: TrustedExtensionApiV1["blobResources"],
  runtime: ChannelRuntime = getChannelRuntime(fetcher, rpc, activationSignal),
) {
  const { signal, client } = runtime;
  rpc = runtime.rpc;
  const pictures = createChannelPictures({
    client,
    blobs,
    signal,
    scope: () => JSON.stringify(["im-channel", viewId, runtime.identity]),
  });
  const drafts = new Map<string, Draft>(),
    opening = new Map<string, Promise<Draft>>(),
    display = createChannelDisplayCache();
  const retireChannel = (id: string) => {
    display.delete(id);
    pictures.revoke(id);
    const draft = drafts.get(id);
    if (!draft) return;
    draft.controller.dispatch({ type: "clear" });
    draft.reply = undefined;
    draft.attempt = undefined;
    void draft.persistence?.clear().catch(() => draftStorageFailed(draft));
    for (const key of draft.files.keys()) removeFile(draft, key);
    draft.controller.dispose();
    drafts.delete(id);
  };
  const scopeId = (id: string) => asConversationScopeId(JSON.stringify([runtime.identity, id]));
  const ids = new Map<ReturnType<typeof scopeId>, string>();
  const leases = createConversationScopeLeaseRegistry({
    onDisposeScope(scope) {
      const id = ids.get(scope);
      if (!id) return;
      ids.delete(scope);
      const draft = drafts.get(id);
      drafts.delete(id);
      if (draft) {
        draft.controller.dispose();
        for (const key of draft.files.keys()) removeFile(draft, key);
      }
    },
  });
  const ensure = (id: string) => {
    const scope = scopeId(id);
    ids.set(scope, id);
    leases.ensure(scope, createConversationKey(CHANNELS_HOST_ID, id).hostId, {
      type: "existing-thread",
      key: createConversationKey(CHANNELS_HOST_ID, id),
    });
    return scope;
  };
  function useDirectory() {
    const directory = useSyncExternalStore(runtime.directory.subscribe, runtime.directory.get, runtime.directory.get);
    const personal = useSyncExternalStore(runtime.assistant.subscribe, runtime.assistant.get, runtime.assistant.get);
    const value = personal.value; // Identity may paint from cache; it never grants command authority.
    const assistant =
      value?.channelId && value.assistant
        ? { channelId: value.channelId, actorId: value.assistant.actorId }
        : undefined;
    return {
      groups: directory.value?.all ?? null,
      failed: directory.failed,
      authoritative: directory.authoritative,
      assistant,
    };
  }
  signal.addEventListener(
    "abort",
    () => {
      leases.dispose();
      display.clear();
      drafts.clear();
      opening.clear();
      ids.clear();
    },
    { once: true },
  );
  function ActiveDirectory({ host }: ExtensionSettingsViewProps) {
    const intl = useIntl();
    const { groups, failed, assistant, authoritative: directoryCurrent } = useDirectory();
    if (!groups?.length)
      return (
        <ConversationHistoryStatus presentation={failed ? "cold-error" : groups ? "none" : "cold-loading"}>
          {intl.formatMessage(failed ? labels.stale : labels.emptyGroups)}
        </ConversationHistoryStatus>
      );
    return (
      <NavigationList label={intl.formatMessage(title)}>
        <NavigationGroup>
          {[...groups.filter((group) => group.id === assistant?.channelId), ...recentGroups(groups)].map((group) => (
            <NavigationItem
              key={group.id}
              disabled={!directoryCurrent}
              aria-current={
                host.activeView?.viewId === viewId && parseChannelResource(host.activeView.resourceUri)?.id === group.id
                  ? "page"
                  : undefined
              }
              onClick={() => host.openView(viewId, resource(group.id))}
            >
              {assistant?.channelId === group.id && <ChatAvatar id={assistant.actorId} bot />}
              <span>
                {assistant?.channelId === group.id
                  ? intl.formatMessage({ id: "im.direct.assistant", defaultMessage: "My assistant" })
                  : group.title}
              </span>
              {!!group.mentionUnreadCount && (
                <span className="im-channel-mention-unread">
                  {intl.formatMessage({ id: "im.channels.mentionedMe", defaultMessage: "Mentioned you" })}
                </span>
              )}
              {!!group.unreadCount && <span> · {group.unreadCount}</span>}
            </NavigationItem>
          ))}
        </NavigationGroup>
      </NavigationList>
    );
  }

  function ActiveConversation({ activation, reportError, host, regions }: ExtensionSettingsViewProps) {
    const intl = useIntl();
    const { groups, failed, assistant, authoritative: directoryCurrent } = useDirectory();
    const target = parseChannelResource(activation.resourceUri);
    const listed = groups?.find((item) => item.id === target?.id);
    const [resolved, setResolved] = useState<{
      id: string;
      group?: ChannelSummary;
      failed?: boolean;
      denied?: boolean;
    }>();
    const retained = useRef<{ id: string; group: ChannelSummary } | undefined>(undefined);
    if (listed) retained.current = { id: listed.id, group: listed };
    useEffect(() => {
      if (listed || !groups || !target?.id.startsWith("group:")) return;
      if (rpc.supportsGroupLifecycle === false) {
        setResolved({ id: target.id, denied: true });
        return;
      }
      const owner = new AbortController(),
        id = target.id;
      client.watch(
        id,
        async (connection) => {
          const group = await client.group(id, connection);
          if (!owner.signal.aborted && !connection.aborted) setResolved({ id, group });
        },
        (error) => {
          if (owner.signal.aborted) return;
          if (denied(error)) {
            retireChannel(id);
            setResolved({ id, denied: true });
          } else setResolved({ id, failed: true });
        },
        owner.signal,
      );
      return () => owner.abort();
    }, [listed, groups, target?.id]);
    const fallback = resolved?.id === target?.id ? resolved : undefined;
    const group =
      listed ??
      fallback?.group ??
      (!fallback?.denied && retained.current && retained.current.id === target?.id
        ? retained.current.group
        : undefined);
    if (!group)
      return (
        <PendingChannelConversation
          title={intl.formatMessage(title)}
          regions={regions}
          failed={failed || fallback?.failed}
          denied={fallback?.denied || (!!groups && !target?.id.startsWith("group:"))}
        />
      );
    return (
      <DraftConversation
        directoryFailed={failed || !!fallback?.failed}
        directoryCurrent={directoryCurrent && !fallback?.failed}
        key={group.id}
        group={group}
        target={target}
        assistant={assistant}
        reportError={reportError}
        host={host}
        regions={regions}
        groups={groups ?? []}
      />
    );
  }

  function DraftConversation({
    group,
    target,
    assistant,
    reportError,
    host,
    regions,
    groups,
    directoryCurrent,
    directoryFailed,
  }: {
    directoryFailed: boolean;
    directoryCurrent: boolean;
    group: ChannelSummary;
    target: ReturnType<typeof parseChannelResource>;
    assistant?: { channelId: string; actorId: string };
    groups: ChannelSummary[];
    reportError: ExtensionSettingsViewProps["reportError"];
    host: ExtensionSettingsViewProps["host"];
    regions: ExtensionSettingsViewProps["regions"];
  }) {
    const intl = useIntl();
    const [draft, setDraft] = useState<Draft | undefined>(() => drafts.get(group.id));
    useEffect(() => {
      let active = true;
      const scope = ensure(group.id),
        releaseView = leases.retain(scope, "channel-view");
      let pending = opening.get(group.id);
      if (!pending && !drafts.has(group.id)) {
        const releaseRestore = leases.retain(scope, "restore");
        pending = (async () => {
          let persistence: ChannelDraftPersistence | undefined,
            persistenceError = false;
          try {
            if (storage && rpc.draftScope)
              persistence = await openChannelDraftStorage(
                storage,
                rpc.draftScope,
                group.id,
                signal,
                intl.formatMessage(labels.reattach),
              );
            else persistenceError = true;
          } catch {
            if (signal.aborted) throw signal.reason;
            persistenceError = true;
          }
          signal.throwIfAborted();
          const value: Draft = {
            controller: null!,
            files: new Map(),
            persistence,
            persistenceError,
            persistenceListeners: new Set(),
            updateRetention: () => {},
            attempt: persistence?.attempt,
            reply: persistence?.reply,
          };
          value.controller = createComposerController(
            { type: "existing-thread", key: createConversationKey(CHANNELS_HOST_ID, group.id) },
            {
              createId: createClientId,
              now: Date.now,
              drafts: persistence?.storage,
              onDraftStorageError: () => draftStorageFailed(value),
            },
          );
          let releaseInput: (() => void) | undefined;
          value.updateRetention = () => {
            const attachments = value.controller.getSnapshot().draft.attachments;
            for (const key of value.files.keys())
              if (!attachments.some((item) => item.id === key)) removeFile(value, key);
            const retained =
              value.controller.hasRetainedContent() || !!value.reply || !!value.attempt || value.files.size > 0;
            if (retained && !releaseInput) releaseInput = leases.retain(scope, "retained-input");
            else if (!retained && releaseInput) {
              const release = releaseInput;
              releaseInput = undefined;
              release();
            }
          };
          const stop = value.controller.subscribe(value.updateRetention);
          value.controller.onDispose(stop);
          drafts.set(group.id, value);
          value.updateRetention();
          return value;
        })();
        opening.set(group.id, pending);
        void pending
          .finally(() => {
            if (opening.get(group.id) === pending) opening.delete(group.id);
            releaseRestore();
          })
          .catch(() => {});
      }
      void (pending ?? Promise.resolve(drafts.get(group.id)!))
        .then((value) => {
          if (active && !signal.aborted) setDraft(value);
        })
        .catch(() => {});
      return () => {
        active = false;
        releaseView();
      };
    }, [group.id]);
    if (!draft) return <PendingChannelConversation title={group.title} regions={regions} />;
    return (
      <GroupTimeline
        directoryFailed={directoryFailed}
        directoryCurrent={directoryCurrent}
        assistant={assistant}
        key={group.id + ":" + (target?.sequence ?? "latest")}
        focusSequence={target?.sequence}
        group={group}
        client={client}
        runtime={runtime}
        display={display}
        pictures={pictures}
        images={images}
        groupTools={groupTools}
        onDeparted={() => retireChannel(group.id)}
        onJumpToMention={(sequence) => host.openView(viewId, resource(group.id, sequence))}
        draft={draft}
        reportError={reportError}
        host={host}
        regions={regions}
        groups={(groups ?? []).map((item) =>
          assistant?.channelId === item.id
            ? { ...item, title: intl.formatMessage({ id: "im.direct.assistant", defaultMessage: "My assistant" }) }
            : item,
        )}
        onSelect={(next) => host.openView(viewId, resource(next.id))}
      />
    );
  }
  function Conversation(props: ExtensionSettingsViewProps) {
    const active = useSyncExternalStore(runtime.subscribeScope, runtime.getScope, runtime.getScope);
    return active ? (
      <ActiveConversation {...props} />
    ) : (
      <PendingChannelConversation title="" regions={props.regions} denied />
    );
  }
  function Directory(props: ExtensionSettingsViewProps) {
    const active = useSyncExternalStore(runtime.subscribeScope, runtime.getScope, runtime.getScope);
    return active ? <ActiveDirectory {...props} /> : null;
  }
  return { Directory, Conversation };
}
