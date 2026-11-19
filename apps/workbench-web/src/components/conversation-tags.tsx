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
  type ConversationTagAnimal,
  type ConversationTagColor,
  type ConversationTagId,
} from "@opencraft/ui-preferences";
import type { ComponentType } from "react";

export { CONVERSATION_TAG_ANIMALS, CONVERSATION_TAG_COLORS };
export type { ConversationTagAnimal, ConversationTagColor, ConversationTagId };

const animalIcons: Record<ConversationTagAnimal, ComponentType<ActionIconProps>> = {
  cat: AnimalCatIcon,
  fox: AnimalFoxIcon,
  rabbit: AnimalRabbitIcon,
  owl: AnimalOwlIcon,
  whale: AnimalWhaleIcon,
  bear: AnimalBearIcon,
};

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
        } as import("react").CSSProperties}
        aria-hidden="true"
      />
    );
  }
  const animal = tag.slice("animal:".length) as ConversationTagAnimal;
  const Icon = animalIcons[animal];
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" />;
}

export interface ExistingConversationTag {
  readonly id: ConversationTagId;
  readonly count: number;
}

/** Collects tags actually present in Recent, preserving first-seen recency order. */
export function collectExistingConversationTags<T>(
  threads: readonly T[],
  tagsByKey: Readonly<Record<string, ConversationTagId>>,
  keyOf: (thread: T) => string,
): readonly ExistingConversationTag[] {
  const counts = new Map<ConversationTagId, number>();
  for (const thread of threads) {
    const tag = tagsByKey[keyOf(thread)];
    if (!tag) continue;
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()].map(([id, count]) => ({ id, count }));
}
