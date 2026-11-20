import React from "react";
import {
  composerDocumentToPlainText,
  type ComposerDocument,
  type ComposerBlockNode,
} from "@opencraft/composer-core";
import type {
  ChannelMessage,
  ChannelMentionInput,
} from "@opencraft/appserver-protocol";
/** Use the exact plain-text serializer, including nested quotes/list prefixes.
 * Identity comes only from selected same-channel tokens, never an @name regex. */
export function channelComposerPayload(
  document: ComposerDocument,
  channelId: string,
) {
  let text = "";
  const mentions: ChannelMentionInput[] = [],
    wake = new Set<string>(),
    nativeOnly = new Set<string>(),
    referenceOnlyBots = new Set<string>();
  const one = (block: ComposerBlockNode) =>
    composerDocumentToPlainText({ version: 1, blocks: [block] });
  const blocks = (values: readonly ComposerBlockNode[]) =>
    values.forEach((v, i) => {
      if (i) text += "\n";
      block(v);
    });
  function block(b: ComposerBlockNode) {
    if (b.type === "paragraph")
      for (const inline of b.children) {
        const start = text.length;
        text += one({ type: "paragraph", children: [inline] });
        if (
          inline.type === "mention" &&
          inline.metadata?.channelId === channelId &&
          ["person", "agent"].includes(inline.mentionKind)
        ) {
          mentions.push({ actorId: inline.id, start, end: text.length });
          if (inline.metadata?.mentionDelivery === "native-only")
            nativeOnly.add(inline.id);
          if (
            inline.mentionKind === "agent" &&
            inline.metadata?.canWake === false
          )
            referenceOnlyBots.add(inline.id);
          if (
            inline.mentionKind === "agent" &&
            inline.metadata?.canWake !== false
          )
            wake.add(inline.id);
        }
      }
    else if (b.type === "quote") blocks(b.children);
    else if (b.type === "list")
      b.items.forEach((item, i) => {
        if (i) text += "\n";
        text += (b.ordered ? String((b.start ?? 1) + i) + "." : "-") + " ";
        blocks(item.children);
      });
    else text += one(b);
  }
  blocks(document.blocks);
  return {
    text,
    mentions,
    wakeActorIds: [...wake].sort(),
    nativeOnlyActorIds: [...nativeOnly],
    referenceOnlyBotIds: [...referenceOnlyBots],
  };
}
export function ChannelMentionText({ message }: { message: ChannelMessage }) {
  const mentions = message.mentions ?? [];
  let previous = 0;
  const valid =
    mentions.length > 0 &&
    mentions.every((m) => {
      const ok =
        Number.isSafeInteger(m.start) &&
        Number.isSafeInteger(m.end) &&
        m.start >= previous &&
        m.end > m.start &&
        m.end <= message.text.length &&
        message.text.slice(m.start, m.end) === "@" + m.displayName;
      previous = m.end;
      return ok;
    });
  if (!valid)
    return <span className="im-channel-mentions">{message.text}</span>;
  let offset = 0;
  const parts = mentions.map((m) => {
    const plain = message.text.slice(offset, m.start);
    offset = m.end;
    return (
      <span key={m.start}>
        {plain}
        <strong
          className="im-channel-mention"
          data-self={m.isSelf || undefined}
          data-actor-id={m.actorId}
        >
          {message.text.slice(m.start, m.end)}
        </strong>
      </span>
    );
  });
  return (
    <span className="im-channel-mentions">
      {parts}
      {message.text.slice(offset)}
    </span>
  );
}

export function channelMentionSpans(message: ChannelMessage) {
  let previous = 0;
  const values = message.mentions ?? [];
  if (
    values.length > 32 ||
    values.some((m) => {
      const valid =
        Number.isSafeInteger(m.start) &&
        Number.isSafeInteger(m.end) &&
        m.start >= previous &&
        m.end > m.start &&
        m.end <= message.text.length &&
        message.text.slice(m.start, m.end) === "@" + m.displayName;
      previous = m.end;
      return !valid;
    })
  )
    return [];
  return values.map(({ start, end }) => ({ start, end }));
}
/** Only explicit parser literals can become native highlights. Rendered @names,
 * including duplicate labels and decoded entities, never resolve an identity. */
export function channelMentionRenderer(message: ChannelMessage) {
  return (node: {
    text: string;
    literalSourceRange?: { start: number; end: number };
  }) => {
    const range = node.literalSourceRange;
    if (!range) return node.text;
    const mention = message.mentions?.find(
      (m) => m.start === range.start && m.end === range.end,
    );
    if (!mention || message.text.slice(range.start, range.end) !== node.text)
      return node.text;
    return (
      <ChannelMentionText
        message={{
          ...message,
          text: node.text,
          mentions: [{ ...mention, start: 0, end: node.text.length }],
        }}
      />
    );
  };
}
