import { useState, useSyncExternalStore } from "react";
import { IconButton } from "@opencraft/design-system-web/button";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import { CloseIcon, TagIcon } from "@opencraft/design-system-web/action-icons";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import { recentConversationKey } from "../sidebar-activity";
import { useUiPreferencesRuntime } from "../runtime/ui-preferences-runtime";
import { useAsyncNotices } from "./async-notices";
import { useWorkbenchPresentationRoot } from "./workbench-presentation-root";
import {
  CONVERSATION_TAG_ANIMALS,
  CONVERSATION_TAG_COLORS,
  ConversationTagMark,
  ConversationTagMarks,
  conversationTagLabel,
  normalizeConversationTags,
  toggleConversationTag,
  type ConversationTagId,
  type ExistingConversationTag,
} from "./conversation-tags";
import "./conversation-tags.scss";

export function ConversationTagPalette({
  values,
  onToggle,
  onClear,
}: {
  readonly values: readonly ConversationTagId[];
  readonly onToggle: (tag: ConversationTagId) => void;
  readonly onClear: () => void;
}) {
  const intl = useIntl();
  const groupLabel = intl.formatMessage({ id: "conversation.tag.label", defaultMessage: "Tag" });

  return (
    <div
      className="conversation-tag-palette"
      role="group"
      aria-label={groupLabel}
      onKeyDown={event => {
        if (["ArrowLeft", "ArrowRight"].includes(event.key)) event.stopPropagation();
      }}
    >
      <div className="conversation-tag-palette__header">
        <span>{groupLabel}</span>
        {values.length > 0 ? (
          <button
            type="button"
            className="conversation-tag-palette__clear"
            onClick={onClear}
          >
            <CloseIcon size={12} aria-hidden="true" />
            <FormattedMessage id="conversation.tag.clear" defaultMessage="Clear" />
          </button>
        ) : null}
      </div>
      <div className="conversation-tag-palette__colors">
        {CONVERSATION_TAG_COLORS.map(color => {
          const id: ConversationTagId = `color:${color}`;
          const checked = values.includes(id);
          const label = conversationTagLabel(intl, id);
          return (
            <button
              key={id}
              type="button"
              aria-pressed={checked}
              aria-label={label}
              title={label}
              className="conversation-tag-palette__swatch"
              onClick={() => onToggle(id)}
            >
              <ConversationTagMark tag={id} />
            </button>
          );
        })}
      </div>
      <div className="conversation-tag-palette__animals">
        {CONVERSATION_TAG_ANIMALS.map(animal => {
          const id: ConversationTagId = `animal:${animal}`;
          const checked = values.includes(id);
          const label = conversationTagLabel(intl, id);
          return (
            <button
              key={id}
              type="button"
              aria-pressed={checked}
              aria-label={label}
              title={label}
              className="conversation-tag-palette__animal"
              onClick={() => onToggle(id)}
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
  values,
  onToggle,
  onClear,
  portalContainer,
}: {
  readonly values: readonly ConversationTagId[];
  readonly onToggle: (tag: ConversationTagId) => void;
  readonly onClear: () => void;
  readonly portalContainer?: HTMLElement | null;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const label = values.length > 0
    ? intl.formatMessage(
        { id: "conversation.tag.current", defaultMessage: "Tag: {tag}" },
        { tag: values.map(item => conversationTagLabel(intl, item)).join(", ") },
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
          {values.length > 0 ? (
            <span className="conversation-tag-header-marks">
              <ConversationTagMarks tags={values} size={14} maxVisible={2} />
            </span>
          ) : (
            <TagIcon size={17} aria-hidden="true" />
          )}
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
            values={values}
            onToggle={onToggle}
            onClear={() => {
              onClear();
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
  const values = normalizeConversationTags(preferenceSnapshot.values["sidebar.conversationTags"][key]);

  const reportError = () => {
    notices.error({
      key: `conversation-tag:${key}`,
      message: intl.formatMessage({ id: "conversation.tag.saveFailed", defaultMessage: "Could not update tag. Try again." }),
    });
  };

  return (
    <ConversationTagHeaderButton
      values={values}
      portalContainer={portalContainer}
      onToggle={tag => {
        void preferences.update("sidebar.conversationTags", current => {
          const next = toggleConversationTag(current[key], tag);
          const { [key]: _removed, ...rest } = current;
          return next.length === 0 ? rest : { ...rest, [key]: next };
        }).catch(reportError);
      }}
      onClear={() => {
        void preferences.update("sidebar.conversationTags", current => {
          const { [key]: _removed, ...rest } = current;
          return rest;
        }).catch(reportError);
      }}
    />
  );
}

export function SidebarRecentTagFilterBar({
  tags,
  selectedTags,
  onToggleTag,
  onClearAll,
}: {
  readonly tags: readonly ExistingConversationTag[];
  readonly selectedTags: readonly ConversationTagId[];
  readonly onToggleTag: (tag: ConversationTagId) => void;
  readonly onClearAll: () => void;
}) {
  const intl = useIntl();

  const missingSelected: ExistingConversationTag[] = selectedTags
    .filter(selected => !tags.some(entry => entry.id === selected))
    .map(id => ({ id, count: 0 }));
  const allEntries: ExistingConversationTag[] = [...missingSelected, ...tags];

  if (allEntries.length === 0) return null;

  const clearLabel = intl.formatMessage({
    id: "sidebar.recent.clearTagFiltersAria",
    defaultMessage: "Clear all tag filters",
  });

  return (
    <div
      className="sidebar-recent-tag-filters"
      role="toolbar"
      aria-label={intl.formatMessage({ id: "sidebar.recent.tagFilter", defaultMessage: "Filter Recent by tag" })}
    >
      {allEntries.map(entry => {
        const active = selectedTags.includes(entry.id);
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
            onClick={() => onToggleTag(entry.id)}
          >
            <ConversationTagMark tag={entry.id} size={13} />
          </button>
        );
      })}
      {selectedTags.length > 0 ? (
        <button
          type="button"
          className="sidebar-recent-tag-clear"
          aria-label={clearLabel}
          title={clearLabel}
          onClick={onClearAll}
        >
          <CloseIcon size={11} aria-hidden="true" />
          <span>
            <FormattedMessage id="sidebar.recent.clearTagFilters" defaultMessage="Clear" />
          </span>
        </button>
      ) : null}
    </div>
  );
}
