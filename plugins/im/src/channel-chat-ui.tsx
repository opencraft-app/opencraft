import { extractMarkdownElement, writeToClipboard } from "@opencraft/chat-render-web";
import { ModalContent } from "@opencraft/design-system-web/modal-content";
import * as ContextMenu from "@opencraft/design-system-web/context-menu";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { useState, useRef, useContext, type ReactNode } from "react";
import {
  CHANNEL_AVATAR_PARTICIPANT_LIMIT,
  type ChannelMessageSender,
  type ChannelSummary,
  type PersonalAssistantWorkSummary,
} from "@opencraft/appserver-protocol";
import type { CompanionActivity } from "@opencraft/design-system/companion-motion";
import { CompanionAvatar } from "@opencraft/design-system-web/companion-avatar";
import { Button, IconButton, ObjectActionSurface, ObjectTitleButton } from "@opencraft/design-system-web/button";
import {
  CheckIcon,
  SearchIcon,
  CloseIcon,
  MessageIcon,
  AddIcon,
  MoreIcon,
  ChevronRightIcon,
} from "@opencraft/design-system-web/action-icons";
import { isCurrentAssistantWork } from "@opencraft/appserver-protocol/assistant-work";
import { AvatarImage, IdentityAvatarContext, SettingsTextInput } from "@opencraft/extension-react";
import { useIntl } from "@opencraft/i18n/react";

export function ChatAvatar({
  id,
  label = id,
  bot = false,
  activity = "rest",
  avatar,
}: {
  id: string;
  label?: string;
  bot?: boolean;
  activity?: CompanionActivity;
  avatar?: ChannelMessageSender["avatar"];
}) {
  const provider = useContext(IdentityAvatarContext);
  const src = !bot && avatar ? (provider?.resolve(avatar.kind, avatar.name) ?? null) : null;
  return bot ? (
    <CompanionAvatar id={id} size={32} activity={activity} />
  ) : (
    <span className="im-channel-chat__person" aria-hidden="true">
      <AvatarImage src={src} fallback={Array.from(label.trim()).slice(0, 1).join("").toLocaleUpperCase()} />
    </span>
  );
}

/** Directory-owned identities; never borrow the last speaker's photo for a group. */
export function ConversationAvatar({
  group,
  assistantActorId,
  activity = "rest",
  legacyPeer,
}: {
  group: ChannelSummary;
  assistantActorId?: string;
  activity?: CompanionActivity;
  legacyPeer?: ChannelMessageSender;
}) {
  if (assistantActorId) return <ChatAvatar id={assistantActorId} bot activity={activity} />;
  if (group.kind === "direct") {
    const peer = group.participants?.[0];
    const old = group.participants === undefined ? legacyPeer : undefined;
    return (
      <ChatAvatar
        id={peer?.actorId ?? old?.id ?? group.id}
        label={group.title}
        avatar={peer?.avatar ?? old?.avatar}
        bot={(peer?.actorKind ?? old?.actorKind) === "session"}
        activity={activity}
      />
    );
  }
  const members = group.participants?.slice(0, CHANNEL_AVATAR_PARTICIPANT_LIMIT) ?? [];
  if (!members.length) return <ChatAvatar id={group.id} label={group.title} />;
  const portraits = members.map((member) => (
    <ChatAvatar
      key={member.actorId}
      id={member.actorId}
      label={member.displayName}
      avatar={member.avatar}
      bot={member.actorKind === "session"}
    />
  ));
  return (
    <span className="im-channel-chat__group-avatar" data-count={members.length} aria-hidden="true">
      {portraits}
    </span>
  );
}

function UtilityDialog({
  title,
  trigger,
  children,
  open,
  onOpenChange,
}: {
  title: string;
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const intl = useIntl(),
    closeRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <ModalContent
        overlayClassName={"modal-surface__scrim"}
        overlayProps={{ "data-layer": "nested" }}
        className="modal-surface im-channel-chat__dialog"
        data-size="utility"
        data-layer="nested"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          closeRef.current?.focus({ preventScroll: true });
        }}
      >
        <header>
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Close asChild>
            <IconButton
              ref={closeRef}
              aria-label={intl.formatMessage({ id: "im.direct.close", defaultMessage: "Close" })}
            >
              <CloseIcon />
            </IconButton>
          </Dialog.Close>
        </header>
        {children}
      </ModalContent>
    </Dialog.Root>
  );
}

export function ChatSwitcher({
  groups,
  selected,
  assistant,
  onSelect,
}: {
  groups: ChannelSummary[];
  selected: string;
  assistant?: { channelId: string; actorId: string } | null;
  onSelect: (group: ChannelSummary) => void;
}) {
  const intl = useIntl(),
    [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  const done = useRef<HTMLButtonElement>(null);
  const label = intl.formatMessage({ id: "im.direct.switch", defaultMessage: "Switch chat" });
  const search = intl.formatMessage({ id: "im.direct.searchChats", defaultMessage: "Search chats" });
  const filtered = groups.filter((group) => group.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const changeOpen = (value: boolean) => {
    setOpen(value);
    if (!value) setQuery("");
  };
  const select = (group: ChannelSummary) => {
    changeOpen(false);
    if (group.id !== selected) onSelect(group);
  };
  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Trigger asChild>
        <IconButton size="navigation" surface="floating" aria-label={label} title={label}>
          <MessageIcon />
        </IconButton>
      </Dialog.Trigger>
      <ModalContent
        overlayClassName={"modal-surface__scrim"}
        overlayProps={{ "data-layer": "nested" }}
        className="modal-surface im-chat-overview"
        data-layer="nested"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          done.current?.focus({ preventScroll: true });
        }}
      >
        <Dialog.Title className="sr-only">{label}</Dialog.Title>
        <div className="im-chat-overview__layout">
          <div className="im-chat-overview__search">
            <SettingsTextInput
              leadingIcon={<SearchIcon />}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={search}
              aria-label={search}
            />
          </div>
          <div className="im-chat-overview__scroll">
            <div className="im-chat-overview__grid">
              {filtered.map((group) => {
                const current = group.id === selected;
                const bot = assistant?.channelId === group.id;
                return (
                  <ObjectActionSurface
                    className="im-chat-overview__card"
                    data-active={current}
                    key={group.id}
                    onOpen={() => select(group)}
                  >
                    <div className="im-chat-overview__heading">
                      <ConversationAvatar group={group} assistantActorId={bot ? assistant!.actorId : undefined} />
                      <div className="im-chat-overview__title" data-object-scroll>
                        <ObjectTitleButton
                          prominence="preview"
                          aria-current={current ? "page" : undefined}
                          onClick={() => select(group)}
                        >
                          {group.title}
                        </ObjectTitleButton>
                      </div>
                      {current ? <CheckIcon className="im-chat-overview__selected" aria-hidden="true" /> : null}
                    </div>
                    <div className="im-chat-overview__preview" aria-hidden="true">
                      <p>
                        {group.latestMessage?.text ||
                          intl.formatMessage({
                            id: "im.shadow.emptyMessages",
                            defaultMessage: "New messages will appear here.",
                          })}
                      </p>
                    </div>
                    <div className="im-chat-overview__meta">
                      {group.latestMessage ? (
                        <time dateTime={new Date(group.latestMessage.at).toISOString()}>
                          {intl.formatDate(group.latestMessage.at, { month: "short", day: "numeric" })}
                        </time>
                      ) : (
                        <span />
                      )}
                      {!!group.unreadCount && (
                        <span
                          className="im-chat-overview__unread"
                          aria-label={intl.formatMessage(
                            { id: "im.direct.unread", defaultMessage: "{count} unread" },
                            { count: group.unreadCount },
                          )}
                        >
                          {group.unreadCount > 99 ? "99+" : group.unreadCount}
                        </span>
                      )}
                    </div>
                  </ObjectActionSurface>
                );
              })}
            </div>
            {!filtered.length ? (
              <p className="im-chat-overview__empty" role="status">
                {intl.formatMessage({ id: "im.direct.noMatchingChats", defaultMessage: "No matching chats" })}
              </p>
            ) : null}
          </div>
          <footer className="im-chat-overview__footer">
            <span>
              {intl.formatMessage(
                { id: "im.direct.chatCount", defaultMessage: "{count} chats" },
                { count: groups.length },
              )}
            </span>
            <IconButton
              ref={done}
              size="navigation"
              surface="floating"
              variant="primary"
              aria-label={intl.formatMessage({ id: "common.done", defaultMessage: "Done" })}
              onClick={() => changeOpen(false)}
            >
              <CheckIcon />
            </IconButton>
          </footer>
        </div>
      </ModalContent>
    </Dialog.Root>
  );
}

const workLabels = {
  queued: { id: "im.work.queued", defaultMessage: "Waiting to start" },
  running: { id: "im.work.running", defaultMessage: "Working in the background" },
  waiting_input: { id: "im.work.waitingInput", defaultMessage: "Waiting for your reply" },
  awaiting_review: { id: "im.work.review", defaultMessage: "Checking the result" },
  awaiting_delivery: { id: "im.work.delivery", defaultMessage: "Preparing the result" },
  blocked: { id: "im.work.blocked", defaultMessage: "Needs attention" },
  completed: { id: "im.work.completed", defaultMessage: "Completed" },
  cancelled: { id: "im.work.cancelled", defaultMessage: "Cancelled" },
  failed: { id: "im.work.failed", defaultMessage: "Could not complete" },
};
/** Current work is separate from message history. Older Hosts may still send terminal rows. */
export function AssistantCurrentWork({ works }: { works: PersonalAssistantWorkSummary[] }) {
  const intl = useIntl(),
    [open, setOpen] = useState(false);
  const current = works.filter((work) => isCurrentAssistantWork(work.status));
  // Keep the open dialog mounted if its last task finishes until the user dismisses it.
  if (!current.length && !open) return null;
  const first = current.find((work) => work.status === "waiting_input" || work.status === "blocked") ?? current[0];
  const label = intl.formatMessage({ id: "im.work.title", defaultMessage: "Tasks" });
  return (
    <div className="im-channel-chat__current-work">
      <UtilityDialog
        title={label}
        open={open}
        onOpenChange={setOpen}
        trigger={
          <Button
            variant="ghost"
            contentLayout="row"
            className="im-channel-chat__work-summary"
            aria-label={label + " (" + current.length + ")"}
          >
            <span>{first ? intl.formatMessage(workLabels[first.status]) : label}</span>
            <span className="im-channel-chat__work-summary-title">{first?.title}</span>
            <span>{current.length}</span>
            <ChevronRightIcon aria-hidden="true" />
          </Button>
        }
      >
        <div className="im-channel-chat__work-detail">
          {current.length ? (
            <ul>
              {current.map((work) => (
                <li key={work.id}>
                  <p>{work.title}</p>
                  <small>{intl.formatMessage(workLabels[work.status])}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p>{intl.formatMessage({ id: "im.work.noneCurrent", defaultMessage: "No current tasks" })}</p>
          )}
        </div>
      </UtilityDialog>
    </div>
  );
}

/** Same settings destination from the header and Add menu; no inactive fake attachments. */
export function ChatMenu({ onSettings, add = false }: { onSettings(): void; add?: boolean }) {
  const intl = useIntl();
  const label = intl.formatMessage(
    add ? { id: "composer.add", defaultMessage: "Add" } : { id: "im.direct.more", defaultMessage: "More options" },
  );
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <IconButton size={add ? "accessory" : "chrome"} aria-label={label} title={label}>
          {add ? <AddIcon /> : <MoreIcon />}
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="opencraft-composer-selection-menu"
          sideOffset={8}
          align={add ? "start" : "end"}
        >
          <DropdownMenu.Item className="opencraft-composer-selection-menu__item" onSelect={onSettings}>
            {intl.formatMessage({ id: "im.direct.settings", defaultMessage: "Agents and assistant settings" })}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Reply remains available without a permanent action row in the conversation. */
export function MessageMenu({
  enabled,
  children,
  onReply,
  copyText,
  onForward,
  onDownload,
  onCopyImage,
  onShare,
  open,
  onOpenChange,
}: {
  enabled: boolean;
  children: ReactNode;
  onReply?: () => void;
  copyText?: string;
  onForward?: () => void;
  onDownload?: () => void;
  onCopyImage?: () => void;
  onShare?: () => void;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const intl = useIntl(),
    root = useRef<HTMLSpanElement>(null),
    [feedback, setFeedback] = useState("");
  async function copy() {
    setFeedback("");
    const from = root.current,
      docs = from?.querySelectorAll<HTMLElement>(".opencraft-chat-document");
    const parts = docs?.length ? Array.from(docs, (doc) => extractMarkdownElement(doc)) : [];
    const data = parts.length
      ? {
          "text/plain": parts.map((p) => p.plainText).join("\n\n"),
          "text/html": parts.map((p) => p.htmlText).join("\n"),
        }
      : (copyText ?? "");
    try {
      await writeToClipboard(data, from);
      setFeedback(intl.formatMessage({ id: "common.copied", defaultMessage: "Copied" }));
    } catch {
      setFeedback(intl.formatMessage({ id: "browser.input.copyFailed", defaultMessage: "Could not copy. Try again." }));
    }
  }
  if (!enabled) return <>{children}</>;
  return (
    <>
      <ContextMenu.Root open={open} onOpenChange={onOpenChange}>
        <ContextMenu.Trigger ref={root} asChild>
          {children}
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="opencraft-composer-selection-menu">
            {onReply && (
              <ContextMenu.Item className="opencraft-composer-selection-menu__item" onSelect={onReply}>
                {intl.formatMessage({ id: "im.channels.reply", defaultMessage: "Reply" })}
              </ContextMenu.Item>
            )}
            {onForward && (
              <ContextMenu.Item className="opencraft-composer-selection-menu__item" onSelect={onForward}>
                {intl.formatMessage({ id: "im.actions.forward", defaultMessage: "Forward" })}
              </ContextMenu.Item>
            )}
            {onCopyImage && (
              <ContextMenu.Item className="opencraft-composer-selection-menu__item" onSelect={onCopyImage}>
                {intl.formatMessage({ id: "im.actions.copyImage", defaultMessage: "Copy image" })}
              </ContextMenu.Item>
            )}
            {onDownload && (
              <ContextMenu.Item className="opencraft-composer-selection-menu__item" onSelect={onDownload}>
                {intl.formatMessage({ id: "im.actions.download", defaultMessage: "Download attachment" })}
              </ContextMenu.Item>
            )}
            {onShare && (
              <ContextMenu.Item className="opencraft-composer-selection-menu__item" onSelect={onShare}>
                {intl.formatMessage({ id: "im.actions.share", defaultMessage: "Share attachment…" })}
              </ContextMenu.Item>
            )}
            {copyText && (
              <ContextMenu.Item className="opencraft-composer-selection-menu__item" onSelect={() => void copy()}>
                {intl.formatMessage({ id: "chat.message.copy", defaultMessage: "Copy message" })}
              </ContextMenu.Item>
            )}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      <span className="sr-only" role="status">
        {feedback}
      </span>
    </>
  );
}
