import type { ConversationStreamItem } from "./buildConversationStreamItems";

const STREAM_ITEM_HEIGHT_CACHE_LIMIT = 5_000;
const streamItemHeightCache = new Map<string, number>();
const assistantMarkdownHeightCache = new Map<string, number>();

export interface StreamItemHeightEstimateOptions {
  width?: number | null;
}

export function estimateStreamItemHeight(
  item: ConversationStreamItem,
  options: StreamItemHeightEstimateOptions = {},
): number {
  const cachedHeight = streamItemHeightCache.get(streamItemHeightCacheKey(item, options));
  if (cachedHeight !== undefined) return cachedHeight;

  switch (item.kind) {
    case "user_message":
      return hasImagePart(item) ? 220 : 96;
    case "assistant_markdown":
      return (
        readAssistantMarkdownCachedHeight(item, options) ??
        estimateAssistantMarkdownHeight(item)
      );
    case "turn_meta":
      return 42;
    case "agent_work":
      return item.block.kind === "agent_work" && item.block.display === "prominent"
        ? 88
        : 40;
    case "status":
      return 48;
    default:
      return 120;
  }
}

export function recordMeasuredStreamItemHeight(
  item: ConversationStreamItem,
  height: number,
  options: StreamItemHeightEstimateOptions = {},
): number | null {
  if (!Number.isFinite(height) || height <= 0) return null;

  const normalizedHeight = Math.ceil(height);
  const key = streamItemHeightCacheKey(item, options);
  touchHeightCache(streamItemHeightCache, key, normalizedHeight);
  recordAssistantMarkdownCachedHeight(item, normalizedHeight, options);
  return normalizedHeight;
}

export function clearStreamItemHeightEstimateCache() {
  streamItemHeightCache.clear();
  assistantMarkdownHeightCache.clear();
}

function streamItemHeightCacheKey(
  item: ConversationStreamItem,
  options: StreamItemHeightEstimateOptions,
) {
  return `${item.key}:${item.fingerprint}:${streamItemWidthKey(options.width)}`;
}

function streamItemWidthKey(width: number | null | undefined) {
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) {
    return "w:*";
  }
  return `w:${Math.round(width)}`;
}

function readAssistantMarkdownCachedHeight(
  item: ConversationStreamItem,
  options: StreamItemHeightEstimateOptions,
) {
  const key = assistantMarkdownHeightCacheKey(item, options);
  if (!key) return null;
  return assistantMarkdownHeightCache.get(key) ?? null;
}

function recordAssistantMarkdownCachedHeight(
  item: ConversationStreamItem,
  height: number,
  options: StreamItemHeightEstimateOptions,
) {
  const key = assistantMarkdownHeightCacheKey(item, options);
  if (!key) return;
  touchHeightCache(assistantMarkdownHeightCache, key, height);
}

function assistantMarkdownHeightCacheKey(
  item: ConversationStreamItem,
  options: StreamItemHeightEstimateOptions,
) {
  if (item.block.kind !== "assistant_markdown") return null;
  const markdown = item.block.blocks.map((block) => block.text).join("\n---block---\n");
  if (!markdown) return null;
  return `assistant:${streamItemWidthKey(options.width)}:streaming:${item.block.streaming}:copy:${item.block.showCopyAction}:${hashString(markdown)}`;
}

function touchHeightCache(cache: Map<string, number>, key: string, height: number) {
  cache.delete(key);
  cache.set(key, height);
  if (cache.size > STREAM_ITEM_HEIGHT_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey === "string") cache.delete(oldestKey);
  }
}

function hasImagePart(item: ConversationStreamItem) {
  return (
    item.block.kind === "user_message" &&
    item.block.parts.some((part) => part.type === "image")
  );
}

function estimateAssistantMarkdownHeight(item: ConversationStreamItem) {
  if (item.block.kind !== "assistant_markdown") return 160;
  const textLength = item.block.blocks.reduce(
    (total, block) => total + block.text.length,
    0,
  );
  return Math.min(720, Math.max(120, 80 + Math.ceil(textLength / 72) * 24));
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${(hash >>> 0).toString(36)}`;
}
