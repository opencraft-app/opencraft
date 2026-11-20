import {
  AnimalBearIcon,
  AnimalCatIcon,
  AnimalFoxIcon,
  AnimalOwlIcon,
  AnimalRabbitIcon,
  AnimalWhaleIcon,
  type ActionIconProps,
} from "@opencraft/design-system-web/action-icons";
import type { IntlShape } from "@opencraft/i18n";
import {
  CONVERSATION_TAG_ANIMALS,
  CONVERSATION_TAG_COLORS,
  isConversationTagId,
  type ConversationTagAnimal,
  type ConversationTagColor,
  type ConversationTagId,
} from "@opencraft/ui-preferences";
import type { CSSProperties, ComponentType } from "react";

export { CONVERSATION_TAG_ANIMALS, CONVERSATION_TAG_COLORS };
export type { ConversationTagAnimal, ConversationTagColor, ConversationTagId };

const CANONICAL_TAG_ORDER: readonly ConversationTagId[] = [
  ...CONVERSATION_TAG_COLORS.map((color): ConversationTagId => `color:${color}`),
  ...CONVERSATION_TAG_ANIMALS.map((animal): ConversationTagId => `animal:${animal}`),
];
const orderRank = new Map<ConversationTagId, number>(
  CANONICAL_TAG_ORDER.map((id, index) => [id, index]),
);

const animalIcons: Record<ConversationTagAnimal, ComponentType<ActionIconProps>> = {
  cat: AnimalCatIcon,
  fox: AnimalFoxIcon,
  rabbit: AnimalRabbitIcon,
  owl: AnimalOwlIcon,
  whale: AnimalWhaleIcon,
  bear: AnimalBearIcon,
};

export function normalizeConversationTags(
  value: readonly ConversationTagId[] | ConversationTagId | null | undefined,
): readonly ConversationTagId[] {
  if (!value) return [];
  const items = typeof value === "string" ? [value] : value;
  return [...new Set(items.filter(isConversationTagId))].sort(
    (left, right) => (orderRank.get(left) ?? 99) - (orderRank.get(right) ?? 99),
  );
}

export function toggleConversationTag(
  current: readonly ConversationTagId[] | ConversationTagId | null | undefined,
  target: ConversationTagId,
): readonly ConversationTagId[] {
  const list = normalizeConversationTags(current);
  return list.includes(target)
    ? list.filter(item => item !== target)
    : normalizeConversationTags([...list, target]);
}

/** Multi-tag filtering narrows by intersection: every selected tag must be present. */
export function matchesConversationTagFilters(
  threadTags: readonly ConversationTagId[] | ConversationTagId | null | undefined,
  selectedFilters: readonly ConversationTagId[],
): boolean {
  if (selectedFilters.length === 0) return true;
  const tags = normalizeConversationTags(threadTags);
  return selectedFilters.every(filter => tags.includes(filter));
}

export function conversationTagLabel(intl: IntlShape, tag: ConversationTagId): string {
  switch (tag) {
    case "color:red": return intl.formatMessage({ id: "conversation.tag.color.red", defaultMessage: "Red" });
    case "color:orange": return intl.formatMessage({ id: "conversation.tag.color.orange", defaultMessage: "Orange" });
    case "color:green": return intl.formatMessage({ id: "conversation.tag.color.green", defaultMessage: "Green" });
    case "color:cyan": return intl.formatMessage({ id: "conversation.tag.color.cyan", defaultMessage: "Cyan" });
    case "color:blue": return intl.formatMessage({ id: "conversation.tag.color.blue", defaultMessage: "Blue" });
    case "color:indigo": return intl.formatMessage({ id: "conversation.tag.color.indigo", defaultMessage: "Indigo" });
    case "color:purple": return intl.formatMessage({ id: "conversation.tag.color.purple", defaultMessage: "Purple" });
    case "animal:cat": return intl.formatMessage({ id: "conversation.tag.animal.cat", defaultMessage: "Cat" });
    case "animal:fox": return intl.formatMessage({ id: "conversation.tag.animal.fox", defaultMessage: "Fox" });
    case "animal:rabbit": return intl.formatMessage({ id: "conversation.tag.animal.rabbit", defaultMessage: "Rabbit" });
    case "animal:owl": return intl.formatMessage({ id: "conversation.tag.animal.owl", defaultMessage: "Owl" });
    case "animal:whale": return intl.formatMessage({ id: "conversation.tag.animal.whale", defaultMessage: "Whale" });
    case "animal:bear": return intl.formatMessage({ id: "conversation.tag.animal.bear", defaultMessage: "Bear" });
  }
}

export function ConversationTagMark({
  tag,
  size = 14,
}: {
  readonly tag: ConversationTagId;
  readonly size?: number;
}) {
  if (tag.startsWith("color:")) {
    const color = tag.slice("color:".length) as ConversationTagColor;
    return (
      <span
        className="conversation-tag-dot"
        data-tag-color={color}
        style={{
          "--tag-fg": `var(--color-indicator-${color}, var(--color-badge-${color}-foreground))`,
          "--tag-bg": `var(--color-badge-${color}-background)`,
        } as CSSProperties}
        aria-hidden="true"
      />
    );
  }
  const animal = tag.slice("animal:".length) as ConversationTagAnimal;
  const Icon = animalIcons[animal];
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" />;
}

export function ConversationTagMarks({
  tags,
  size = 13,
  maxVisible = 3,
}: {
  readonly tags: readonly ConversationTagId[];
  readonly size?: number;
  readonly maxVisible?: number;
}) {
  if (tags.length === 0) return null;
  const shown = tags.slice(0, maxVisible);
  const extra = tags.length - shown.length;
  return (
    <>
      {shown.map(tag => (
        <ConversationTagMark key={tag} tag={tag} size={size} />
      ))}
      {extra > 0 ? <span className="conversation-tag-extra" aria-hidden="true">+{extra}</span> : null}
    </>
  );
}

export interface ExistingConversationTag {
  readonly id: ConversationTagId;
  readonly count: number;
}

/** Collects all tags present in Recent, preserving first-seen recency order. */
export function collectExistingConversationTags<T>(
  threads: readonly T[],
  tagsByKey: Readonly<Record<string, readonly ConversationTagId[] | ConversationTagId>>,
  keyOf: (thread: T) => string,
): readonly ExistingConversationTag[] {
  const counts = new Map<ConversationTagId, number>();
  for (const thread of threads) {
    const list = normalizeConversationTags(tagsByKey[keyOf(thread)]);
    for (const tag of list) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([id, count]) => ({ id, count }));
}
