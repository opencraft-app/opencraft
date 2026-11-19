import { useState, useSyncExternalStore } from "react";
import { IconButton } from "@opencraft/design-system-web/button";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import { CheckIcon, CloseIcon, TagIcon } from "@opencraft/design-system-web/action-icons";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import { recentConversationKey } from "../sidebar-activity";
import { useUiPreferencesRuntime } from "../runtime/ui-preferences-runtime";
import { useAsyncNotices } from "./async-notices";
import { useWorkbenchPresentationRoot } from "./workbench-presentation-root";
import {
  CONVERSATION_TAG_ANIMALS,
  CONVERSATION_TAG_COLORS,
  ConversationTagMark,
  conversationTagLabel,
  type ConversationTagId,
  type ExistingConversationTag,
} from "./conversation-tags";
import type { SidebarThreadMenuStore } from "./sidebar-thread-menu-state";
import "./conversation-tags.scss";

export function ConversationTagPalette({
  value,
  onSelect,
}: {
  readonly value: ConversationTagId | null;
  readonly onSelect: (next: ConversationTagId | null) => void;
}) {
  const intl = useIntl();
  const groupLabel = intl.formatMessage({ id: "conversation.tag.label", defaultMessage: "Tag" });

  return (
    <div
      className="conversation-tag-palette"
      role="radiogroup"
      aria-label={groupLabel}
      onKeyDown={event => {
        if (["ArrowLeft", "ArrowRight"].includes(event.key)) event.stopPropagation();
      }}
    >
      <div className="conversation-tag-palette__header">
        <span>{groupLabel}</span>
        {value !== null ? (
          <button
            type="button"
            className="conversation-tag-palette__clear"
            onClick={() => onSelect(null)}
          >
            <CloseIcon size={12} aria-hidden="true" />
            <FormattedMessage id="conversation.tag.clear" defaultMessage="Clear" />
          </button>
        ) : null}
      </div>
      <div className="conversation-tag-palette__colors">
        {CONVERSATION_TAG_COLORS.map(color => {
          const id: ConversationTagId = `color:${color}`;
          const checked = value === id;
          const label = conversationTagLabel(intl, id);
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={label}
              title={label}
              className="conversation-tag-palette__swatch"
              onClick={() => onSelect(checked ? null : id)}
            >
              <ConversationTagMark tag={id} />
            </button>
          );
        })}
      </div>
      <div className="conversation-tag-palette__animals">
        {CONVERSATION_TAG_ANIMALS.map(animal => {
          const id: ConversationTagId = `animal:${animal}`;
          const checked = value === id;
          const label = conversationTagLabel(intl, id);
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={label}
              title={label}
              className="conversation-tag-palette__animal"
              onClick={() => onSelect(checked ? null : id)}
            >
              <ConversationTagMark tag={id} size={16} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ConversationTagHeaderButton({
  value,
  onSelect,
  portalContainer,
}: {
  readonly value: ConversationTagId | null;
  readonly onSelect: (next: ConversationTagId | null) => void;
  readonly portalContainer?: HTMLElement | null;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const label = value
    ? intl.formatMessage(
        { id: "conversation.tag.current", defaultMessage: "Tag: {tag}" },
        { tag: conversationTagLabel(intl, value) },
      )
    : intl.formatMessage({ id: "conversation.tag.action", defaultMessage: "Tag conversation" });

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <IconButton
          type="button"
          variant={open ? "secondary" : "ghost"}
          className="chrome-button"
          aria-label={label}
          title={label}
        >
          {value ? <ConversationTagMark tag={value} size={16} /> : <TagIcon size={17} aria-hidden="true" />}
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={portalContainer ?? undefined}>
        <DropdownMenu.Content
          className="workbench-context-menu conversation-tag-popover"
          align="end"
          sideOffset={6}
          collisionPadding={12}
        >
          <ConversationTagPalette
            value={value}
            onSelect={next => {
              onSelect(next);
              setOpen(false);
            }}
          />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function ConversationTagHeaderAction({
  scope,
  hostId,
  threadId,
}: {
  readonly scope: string;
  readonly hostId: string;
  readonly threadId: string;
}) {
  const intl = useIntl();
  const notices = useAsyncNotices();
  const portalContainer = useWorkbenchPresentationRoot();
  const preferences = useUiPreferencesRuntime();
  const preferenceSnapshot = useSyncExternalStore(
    preferences.subscribe,
    preferences.getSnapshot,
    preferences.getSnapshot,
  );
  const key = recentConversationKey(scope, hostId, threadId);
  const value = preferenceSnapshot.values["sidebar.conversationTags"][key] ?? null;

  return (
    <ConversationTagHeaderButton
      value={value}
      portalContainer={portalContainer}
      onSelect={next => {
        void preferences.update("sidebar.conversationTags", current => {
          const { [key]: _removed, ...rest } = current;
          return next === null ? rest : { ...rest, [key]: next };
        }).catch(() => {
          notices.error({
            key: `conversation-tag:${key}`,
            message: intl.formatMessage({ id: "conversation.tag.saveFailed", defaultMessage: "Could not update tag. Try again." }),
          });
        });
      }}
    />
  );
}

const MAX_INLINE_TAGS = 4;

export function SidebarRecentTagFilterBar({
  tags,
  selectedTag,
  onSelectTag,
  store,
  portalContainer,
}: {
  readonly tags: readonly ExistingConversationTag[];
  readonly selectedTag: ConversationTagId | null;
  readonly onSelectTag: (tag: ConversationTagId | null) => void;
  readonly store: SidebarThreadMenuStore;
  readonly portalContainer: HTMLElement | null;
}) {
  const intl = useIntl();
  const menuOpen = useSyncExternalStore(
    store.subscribeRecentTags,
    store.getRecentTagsOpen,
    store.getRecentTagsOpen,
  );

  const allEntries: ExistingConversationTag[] = selectedTag && !tags.some(entry => entry.id === selectedTag)
    ? [{ id: selectedTag, count: 0 }, ...tags]
    : [...tags];

  if (allEntries.length === 0) return null;

  const hasOverflow = allEntries.length > MAX_INLINE_TAGS;
  let inlineEntries = hasOverflow ? allEntries.slice(0, MAX_INLINE_TAGS - 1) : allEntries;
  if (hasOverflow && selectedTag && !inlineEntries.some(entry => entry.id === selectedTag)) {
    const selectedEntry = allEntries.find(entry => entry.id === selectedTag)!;
    inlineEntries = [...inlineEntries.slice(0, MAX_INLINE_TAGS - 2), selectedEntry];
  }
  const hiddenCount = allEntries.length - inlineEntries.length;

  return (
    <div
      className="sidebar-recent-tag-filters"
      role="toolbar"
      aria-label={intl.formatMessage({ id: "sidebar.recent.tagFilter", defaultMessage: "Filter Recent by tag" })}
    >
      {inlineEntries.map(entry => {
        const active = selectedTag === entry.id;
        const name = conversationTagLabel(intl, entry.id);
        const title = intl.formatMessage(
          { id: "sidebar.recent.filterByTag", defaultMessage: "Filter by {tag}" },
          { tag: name },
        );
        return (
          <button
            key={entry.id}
            type="button"
            className="sidebar-recent-tag-chip"
            aria-pressed={active}
            aria-label={title}
            title={title}
            onClick={() => onSelectTag(active ? null : entry.id)}
          >
            <ConversationTagMark tag={entry.id} size={13} />
          </button>
        );
      })}
      {hasOverflow ? (
        <DropdownMenu.Root open={menuOpen} onOpenChange={store.setRecentTagsOpen}>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="sidebar-recent-tag-chip"
              aria-label={intl.formatMessage({ id: "sidebar.recent.moreTags", defaultMessage: "More tags" })}
              title={intl.formatMessage({ id: "sidebar.recent.moreTags", defaultMessage: "More tags" })}
            >
              +{hiddenCount}
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal container={portalContainer}>
            <DropdownMenu.Content
              className="workbench-context-menu"
              align="end"
              sideOffset={4}
              onCloseAutoFocus={event => {
                if (store.getSnapshot() !== null) event.preventDefault();
              }}
            >
              <DropdownMenu.Item
                onSelect={() => {
                  onSelectTag(null);
                  store.setRecentTagsOpen(false);
                }}
              >
                <FormattedMessage id="sidebar.recent.allTags" defaultMessage="All recent" />
                {selectedTag === null ? <CheckIcon size={14} aria-hidden="true" /> : null}
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              {allEntries.map(entry => {
                const active = selectedTag === entry.id;
                return (
                  <DropdownMenu.Item
                    key={entry.id}
                    onSelect={() => {
                      onSelectTag(active ? null : entry.id);
                      store.setRecentTagsOpen(false);
                    }}
                  >
                    <ConversationTagMark tag={entry.id} size={14} />
                    <span>{conversationTagLabel(intl, entry.id)}</span>
                    <span className="sidebar-recent-tag-menu-count">{entry.count}</span>
                    {active ? <CheckIcon size={14} aria-hidden="true" /> : null}
                  </DropdownMenu.Item>
                );
              })}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : null}
    </div>
  );
}
