import type { WebBlock, WebTurn } from "../../adapters/toWebBlocks";

export interface ConversationStreamItem {
  id: string;
  key: string;
  kind: WebBlock["kind"];
  sourceTurnId: string;
  sourceActivityId?: string;
  live: boolean;
  continuation: boolean;
  fingerprint: string;
  createdAt: string;
  block: WebBlock;
}

const streamItemsByTurns = new WeakMap<readonly WebTurn[], ConversationStreamItem[]>();
const streamItemsByTurn = new WeakMap<WebTurn, ConversationStreamItem[]>();
const STREAM_ITEM_CACHE_LIMIT = 10_000;
const streamItemCache = new Map<string, ConversationStreamItem>();

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
        showCopyAction: block.showCopyAction && isTailBlock,
      };
      return itemFromBlock(turn, splitBlock, {
        id: `${turn.id}:${markdownBlock.id}`,
        key: `${turn.key}:${markdownBlock.id}`,
        continuation: index > 0,
        fingerprint: `md:${markdownBlock.id}:streaming:${splitBlock.streaming}:copy:${splitBlock.showCopyAction ? hashString(splitBlock.copyText) : "hidden"}:${hashString(markdownBlock.text)}`,
      });
    });
  }

  return [
    itemFromBlock(turn, block, {
      id: turn.blocks.length === 1 ? turn.id : `${turn.id}:${block.id}`,
      key: turn.blocks.length === 1 ? turn.key : `${turn.key}:${block.key}`,
      continuation: false,
      fingerprint: blockFingerprint(block),
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
  const sourceTurnId = block.sourceTurnId ?? turn.sourceTurnId ?? turn.id;
  const sourceActivityId = block.sourceActivityId ?? turn.sourceActivityId;
  const live = isLiveBlock(block, turn.live);
  const cacheKey = [
    identity.key,
    identity.fingerprint,
    `live:${live}`,
    `turn:${sourceTurnId}`,
    `activity:${sourceActivityId ?? ""}`,
  ].join(":");
  const cached = streamItemCache.get(cacheKey);
  if (cached) return cached;

  const item = {
    id: identity.id,
    key: identity.key,
    kind: block.kind,
    sourceTurnId,
    sourceActivityId,
    live,
    continuation: identity.continuation,
    fingerprint: identity.fingerprint,
    createdAt: block.createdAt,
    block,
  };
  streamItemCache.set(cacheKey, item);
  evictOldestStreamItemIfNeeded();
  return item;
}

function evictOldestStreamItemIfNeeded() {
  if (streamItemCache.size <= STREAM_ITEM_CACHE_LIMIT) return;
  const oldestKey = streamItemCache.keys().next().value;
  if (typeof oldestKey === "string") {
    streamItemCache.delete(oldestKey);
  }
}

function isLiveBlock(block: WebBlock, turnLive: boolean) {
  if (block.kind === "assistant_markdown") return block.streaming;
  if (block.kind === "agent_work") {
    return block.status === "running" || block.status === "pending";
  }
  return turnLive;
}

function blockFingerprint(block: WebBlock): string {
  if (block.kind === "user_message") {
    return `${block.key}:created:${hashString(block.createdAt)}:collapsed:${block.collapsed}:len:${block.text.length}:text:${hashString(block.text)}:copy:${hashString(block.copyText)}:parts:${partsFingerprint(block.parts)}`;
  }
  if (block.kind === "assistant_markdown") {
    const textLength = block.blocks.reduce((total, markdownBlock) => total + markdownBlock.text.length, 0);
    const blockHash = hashString(
      block.blocks.map((markdownBlock) => `${markdownBlock.id}:${markdownBlock.text}`).join("\n---block---\n"),
    );
    return `${block.key}:created:${hashString(block.createdAt)}:streaming:${block.streaming}:copy:${block.showCopyAction}:len:${textLength}:hash:${blockHash}`;
  }
  if (block.kind === "turn_meta") {
    return `${block.key}:created:${hashString(block.createdAt)}:updated:${hashString(block.updatedAt ?? "")}:completed:${hashString(block.completedAt ?? "")}:status:${block.status}:label:${hashString(block.label)}`;
  }
  if (block.kind === "agent_work") {
    return `${block.key}:${block.status}:display:${block.display}:created:${hashString(block.createdAt)}:updated:${hashString(block.updatedAt ?? "")}:title:${hashString(block.title)}:summary:${hashString(block.summary)}`;
  }
  return `${block.key}:created:${hashString(block.createdAt)}:status:${block.status}:label:${hashString(block.label)}`;
}

function partsFingerprint(parts: Extract<WebBlock, { kind: "user_message" }>["parts"]) {
  return parts
    .map((part) => {
      const data = part.data;
      const encodedLength =
        typeof data?.data === "string" ? data.data.length : 0;
      const encodedHash = typeof data?.data === "string" ? hashString(data.data) : "";
      const mimeType = typeof data?.mime_type === "string" ? data.mime_type : "";
      const sha256 = typeof data?.sha256 === "string" ? data.sha256 : "";
      const blobId = typeof data?.blob_id === "string" ? data.blob_id : "";
      const sizeBytes =
        typeof data?.size_bytes === "number" && Number.isFinite(data.size_bytes)
          ? data.size_bytes
          : "";
      return `${part.id}:${part.type}:text:${hashString(part.text ?? "")}:mime:${mimeType}:sha:${sha256}:blob:${blobId}:size:${sizeBytes}:data:${encodedLength}:${encodedHash}`;
    })
    .join("|");
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${(hash >>> 0).toString(36)}`;
}
