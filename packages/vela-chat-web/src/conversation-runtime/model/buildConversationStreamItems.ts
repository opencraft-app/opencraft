import type { WebBlock, WebTurn } from "../../adapters/toWebBlocks";

export interface ConversationStreamItem {
  id: string;
  key: string;
  kind: WebBlock["kind"];
  sourceTurnId: string;
  live: boolean;
  continuation: boolean;
  fingerprint: string;
  createdAt: string;
  block: WebBlock;
}

const streamItemsByTurns = new WeakMap<readonly WebTurn[], ConversationStreamItem[]>();
const streamItemsByTurn = new WeakMap<WebTurn, ConversationStreamItem[]>();

export function buildConversationStreamItems(
  turns: readonly WebTurn[],
): ConversationStreamItem[] {
  const cached = streamItemsByTurns.get(turns);
  if (cached) return cached;

  const items = turns.flatMap((turn) => cachedTurnToItems(turn));
  streamItemsByTurns.set(turns, items);
  return items;
}

function cachedTurnToItems(turn: WebTurn): ConversationStreamItem[] {
  const cached = streamItemsByTurn.get(turn);
  if (cached) return cached;

  const items = turnToItems(turn);
  streamItemsByTurn.set(turn, items);
  return items;
}

function turnToItems(turn: WebTurn): ConversationStreamItem[] {
  return turn.blocks.flatMap((block) => blockToItems(turn, block));
}

function blockToItems(turn: WebTurn, block: WebBlock): ConversationStreamItem[] {
  if (block.kind === "assistant_markdown" && block.blocks.length > 1) {
    return block.blocks.map((markdownBlock, index) => {
      const isTailBlock = index === block.blocks.length - 1;
      const splitBlock: WebBlock = {
        ...block,
        id: `${block.id}:${markdownBlock.id}`,
        key: `${block.key}:${markdownBlock.id}`,
        blocks: [markdownBlock],
        streaming: block.streaming && isTailBlock,
        settledLabel: index === 0 ? block.settledLabel : undefined,
      };
      return itemFromBlock(turn, splitBlock, {
        id: `${turn.id}:${markdownBlock.id}`,
        key: `${turn.key}:${markdownBlock.id}`,
        continuation: index > 0,
        fingerprint: `md:${markdownBlock.id}:${hashString(markdownBlock.text)}`,
      });
    });
  }

  return [
    itemFromBlock(turn, block, {
      id: turn.blocks.length === 1 ? turn.id : `${turn.id}:${block.id}`,
      key: turn.blocks.length === 1 ? turn.key : `${turn.key}:${block.key}`,
      continuation: false,
      fingerprint: `${turn.fingerprint}:${block.key}`,
    }),
  ];
}

function itemFromBlock(
  turn: WebTurn,
  block: WebBlock,
  identity: {
    id: string;
    key: string;
    continuation: boolean;
    fingerprint: string;
  },
): ConversationStreamItem {
  return {
    id: identity.id,
    key: identity.key,
    kind: block.kind,
    sourceTurnId: turn.id,
    live: isLiveBlock(block, turn.live),
    continuation: identity.continuation,
    fingerprint: identity.fingerprint,
    createdAt: block.createdAt,
    block,
  };
}

function isLiveBlock(block: WebBlock, turnLive: boolean) {
  if (block.kind === "assistant_markdown") return block.streaming;
  if (block.kind === "agent_work") {
    return block.status === "running" || block.status === "pending";
  }
  return turnLive;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${(hash >>> 0).toString(36)}`;
}
