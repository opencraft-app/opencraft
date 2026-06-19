import assert from "node:assert/strict";
import test from "node:test";

import type { WebTurn } from "../src/adapters/toWebBlocks";
import { toWebChatModel } from "../src/adapters/toWebBlocks";
import {
  buildConversationRuntimeSegments,
  buildConversationStreamItems,
  conversationRuntimePolicyForHost,
  DEFAULT_CONVERSATION_RUNTIME_POLICY,
  summarizeConversationRuntime,
} from "../src/conversation-runtime/model";
import {
  clearStreamItemHeightEstimateCache,
  estimateStreamItemHeight,
  recordMeasuredStreamItemHeight,
} from "../src/conversation-runtime/model/estimateStreamItemHeight";
import {
  deriveBottomAnchorRouteReadiness,
  deriveBottomAnchorFollowState,
  shouldCancelPendingStickForUserScrollIntent,
  shouldRestickOnContentSizeChange,
  shouldRetryBottomStickAfterSettle,
  shouldRestickOnViewportSizeChange,
  USER_SCROLL_DELTA_EPSILON,
} from "../src/conversation-runtime/scroll/bottomAnchor";
import {
  DEFAULT_HISTORY_START_THRESHOLD_PX,
  deriveScrollTopAfterHistoryPrepend,
  shouldRequestOlderHistory,
} from "../src/conversation-runtime/scroll/historyPaging";
import {
  buildConversationScrollResumeStorageKey,
  deriveConversationScrollResumeDecision,
  parseConversationScrollResumeState,
  serializeConversationScrollResumeState,
} from "../src/conversation-runtime/scroll/routeResume";
import { resolveConversationStrategyName } from "../src/conversation-runtime/strategy/strategyResolver";
import type { ChatRenderModel } from "../../vela-chat-render-model/src";

function turn(id: string, options: { live?: boolean } = {}): WebTurn {
  return {
    id,
    key: `turn:${id}`,
    fingerprint: `turn:${id}`,
    live: options.live ?? false,
    blocks: [
      {
        kind: "status",
        id: `status:${id}`,
        key: `status:${id}`,
        label: id,
        createdAt: "2026-06-18T00:00:00Z",
      },
    ],
  };
}

test("conversation runtime keeps live items out of virtualized history", () => {
  const turns = [turn("old-1"), turn("old-2"), turn("live", { live: true })];
  const items = buildConversationStreamItems(turns);

  const segments = buildConversationRuntimeSegments(items, {
    virtualizeAfterItemCount: 1,
    mountedRecentItemCount: 1,
  });

  assert.deepEqual(segments.historyVirtualized.map((item) => item.id), ["old-1"]);
  assert.deepEqual(segments.historyMounted.map((item) => item.id), ["old-2"]);
  assert.deepEqual(segments.liveHead.map((item) => item.id), ["live"]);
  assert.equal(segments.boundary.hasVirtualizedHistory, true);
  assert.equal(segments.boundary.hasLiveHead, true);
});

test("conversation runtime reuses measured item heights only while the item fingerprint matches", () => {
  clearStreamItemHeightEstimateCache();
  const item = buildConversationStreamItems([turn("measured")])[0]!;

  assert.equal(estimateStreamItemHeight(item), 48);
  assert.equal(recordMeasuredStreamItemHeight(item, 137.2), 138);
  assert.equal(estimateStreamItemHeight(item), 138);
  assert.equal(
    estimateStreamItemHeight({
      ...item,
      fingerprint: `${item.fingerprint}:changed`,
    }),
    48,
  );
});

test("conversation runtime scopes measured item heights by viewport width", () => {
  clearStreamItemHeightEstimateCache();
  const item = buildConversationStreamItems([turn("width-measured")])[0]!;

  assert.equal(estimateStreamItemHeight(item, { width: 480 }), 48);
  assert.equal(recordMeasuredStreamItemHeight(item, 137.2, { width: 480 }), 138);
  assert.equal(estimateStreamItemHeight(item, { width: 480 }), 138);
  assert.equal(estimateStreamItemHeight(item, { width: 720 }), 48);
  assert.equal(estimateStreamItemHeight(item), 48);
  assert.equal(
    estimateStreamItemHeight(
      {
        ...item,
        fingerprint: `${item.fingerprint}:changed`,
      },
      { width: 480 },
    ),
    48,
  );
});

test("conversation runtime reuses measured assistant markdown heights across stable content", () => {
  clearStreamItemHeightEstimateCache();
  const model: ChatRenderModel = {
    session_id: "sess_1",
    host: { kind: "desktop_web" },
    rows: [
      {
        kind: "assistant_message",
        id: "a1",
        key: "assistant:a1",
        blocks: [{ id: "a1:block:0", text: "same paragraph\n\nwith a second line" }],
        createdAt: "2026-06-18T00:00:00Z",
        status: "completed",
        streaming: false,
        revision: 1,
        debug: { projection: "transcript", source_event_ids: ["evt_1"] },
      },
      {
        kind: "assistant_message",
        id: "a2",
        key: "assistant:a2",
        blocks: [{ id: "a2:block:0", text: "same paragraph\n\nwith a second line" }],
        createdAt: "2026-06-18T00:00:01Z",
        status: "completed",
        streaming: false,
        revision: 1,
        debug: { projection: "transcript", source_event_ids: ["evt_2"] },
      },
    ],
    composer: { placeholder: "要求后续变更", can_send: true },
  };
  const items = buildConversationStreamItems(toWebChatModel(model).turns);
  const [first, second] = items;

  assert.equal(first?.kind, "assistant_markdown");
  assert.equal(second?.kind, "assistant_markdown");
  assert.notEqual(first?.key, second?.key);
  assert.equal(estimateStreamItemHeight(second!, { width: 640 }), 120);
  assert.equal(recordMeasuredStreamItemHeight(first!, 211.4, { width: 640 }), 212);
  assert.equal(estimateStreamItemHeight(second!, { width: 640 }), 212);
});

test("conversation runtime caps live head so long running turns can still virtualize older live work", () => {
  const items = buildConversationStreamItems(
    Array.from({ length: 8 }, (_, index) =>
      turn(`live-${index + 1}`, { live: true }),
    ),
  );

  const segments = buildConversationRuntimeSegments(items, {
    virtualizeAfterItemCount: 3,
    mountedRecentItemCount: 2,
    maxLiveHeadItemCount: 2,
  });

  assert.deepEqual(
    segments.historyVirtualized.map((item) => item.id),
    ["live-1", "live-2", "live-3", "live-4"],
  );
  assert.deepEqual(
    segments.historyMounted.map((item) => item.id),
    ["live-5", "live-6"],
  );
  assert.deepEqual(
    segments.liveHead.map((item) => item.id),
    ["live-7", "live-8"],
  );
});

test("conversation stream items split assistant markdown blocks inside one long turn", () => {
  const model: ChatRenderModel = {
    session_id: "sess_1",
    host: { kind: "desktop_web" },
    rows: [
      {
        kind: "assistant_message",
        id: "a1",
        key: "assistant:a1",
        blocks: [
          { id: "a1:block:0", text: "first paragraph" },
          { id: "a1:block:1", text: "second paragraph" },
          { id: "a1:block:2", text: "third paragraph" },
        ],
        createdAt: "2026-06-18T00:00:00Z",
        status: "completed",
        streaming: false,
        revision: 1,
        debug: { projection: "transcript", source_event_ids: ["evt_1"] },
      },
    ],
    composer: { placeholder: "要求后续变更", can_send: true },
  };

  const webModel = toWebChatModel(model);
  const items = buildConversationStreamItems(webModel.turns);

  assert.deepEqual(items.map((item) => item.kind), [
    "assistant_markdown",
    "assistant_markdown",
    "assistant_markdown",
  ]);
  assert.deepEqual(
    items.map((item) =>
      item.block.kind === "assistant_markdown" ? item.block.blocks[0]?.id : undefined,
    ),
    ["a1:block:0", "a1:block:1", "a1:block:2"],
  );
});

test("streaming assistant rows stay live and expose a changing fingerprint", () => {
  const model: ChatRenderModel = {
    session_id: "sess_1",
    host: { kind: "desktop_web" },
    rows: [
      {
        kind: "assistant_message",
        id: "a1",
        key: "assistant:a1",
        blocks: [{ id: "a1:block:0", text: "hello" }],
        createdAt: "2026-06-18T00:00:00Z",
        status: "streaming",
        streaming: true,
        revision: 2,
        debug: { projection: "transcript", source_event_ids: ["evt_1", "evt_2"] },
      },
    ],
    composer: { placeholder: "要求后续变更", can_send: true },
  };

  const webModel = toWebChatModel(model);

  assert.equal(webModel.turns[0]?.live, true);
  assert.match(webModel.turns[0]?.fingerprint ?? "", /streaming/);
  assert.match(webModel.turns[0]?.fingerprint ?? "", /rev:2/);
  assert.equal(webModel.turns[0]?.blocks[0]?.kind, "assistant_markdown");
  if (webModel.turns[0]?.blocks[0]?.kind === "assistant_markdown") {
    assert.equal(webModel.turns[0].blocks[0].streaming, true);
  }
});

test("streaming assistant markdown split items keep only the tail block live", () => {
  const model: ChatRenderModel = {
    session_id: "sess_1",
    host: { kind: "desktop_web" },
    rows: [
      {
        kind: "assistant_message",
        id: "a1",
        key: "assistant:a1",
        blocks: [
          { id: "a1:block:0", text: "stable intro" },
          { id: "a1:block:1", text: "stable middle" },
          { id: "a1:block:2", text: "tail still streaming" },
        ],
        createdAt: "2026-06-18T00:00:00Z",
        status: "streaming",
        streaming: true,
        revision: 4,
        debug: { projection: "transcript", source_event_ids: ["evt_1"] },
      },
    ],
    composer: { placeholder: "要求后续变更", can_send: true },
  };

  const items = buildConversationStreamItems(toWebChatModel(model).turns);

  assert.deepEqual(
    items.map((item) => item.live),
    [false, false, true],
  );
  assert.deepEqual(
    items.map((item) =>
      item.block.kind === "assistant_markdown" ? item.block.streaming : null,
    ),
    [false, false, true],
  );
});

test("streaming assistant markdown split items keep stable head fingerprints", () => {
  const firstSnapshot: ChatRenderModel = {
    session_id: "sess_1",
    host: { kind: "desktop_web" },
    rows: [
      {
        kind: "assistant_message",
        id: "a1",
        key: "assistant:a1",
        blocks: [
          { id: "a1:block:0", text: "stable intro" },
          { id: "a1:block:1", text: "tail grows" },
        ],
        createdAt: "2026-06-18T00:00:00Z",
        status: "streaming",
        streaming: true,
        revision: 1,
        debug: { projection: "transcript", source_event_ids: ["evt_1"] },
      },
    ],
    composer: { placeholder: "要求后续变更", can_send: true },
  };
  const secondSnapshot: ChatRenderModel = {
    ...firstSnapshot,
    rows: [
      {
        ...firstSnapshot.rows[0]!,
        blocks: [
          { id: "a1:block:0", text: "stable intro" },
          { id: "a1:block:1", text: "tail grows with another delta" },
        ],
        revision: 2,
      },
    ],
  };

  const firstItems = buildConversationStreamItems(toWebChatModel(firstSnapshot).turns);
  const secondItems = buildConversationStreamItems(toWebChatModel(secondSnapshot).turns);

  assert.equal(firstItems[0]?.fingerprint, secondItems[0]?.fingerprint);
  assert.notEqual(firstItems[1]?.fingerprint, secondItems[1]?.fingerprint);
});

test("web adapter reuses unchanged turns across fresh render model snapshots", () => {
  const firstSnapshot: ChatRenderModel = {
    session_id: "sess_1",
    host: { kind: "desktop_web" },
    rows: [
      {
        kind: "user_message",
        id: "u1",
        key: "user:u1",
        text: "hello",
        copy_text: "hello",
        collapsed: false,
        parts: [{ id: "u1:part:0", type: "text", text: "hello" }],
        createdAt: "2026-06-18T00:00:00Z",
        debug: { projection: "transcript", source_event_ids: ["evt_1"] },
      },
      {
        kind: "assistant_message",
        id: "a1",
        key: "assistant:a1",
        blocks: [{ id: "a1:block:0", text: "old" }],
        createdAt: "2026-06-18T00:00:01Z",
        status: "streaming",
        streaming: true,
        revision: 1,
        debug: { projection: "transcript", source_event_ids: ["evt_2"] },
      },
    ],
    composer: { placeholder: "要求后续变更", can_send: true },
  };
  const secondSnapshot: ChatRenderModel = {
    ...firstSnapshot,
    rows: [
      { ...firstSnapshot.rows[0]! },
      {
        ...firstSnapshot.rows[1]!,
        blocks: [{ id: "a1:block:0", text: "older" }],
        revision: 2,
      },
    ],
  };

  const first = toWebChatModel(firstSnapshot);
  const second = toWebChatModel(secondSnapshot);

  assert.equal(second.turns[0], first.turns[0]);
  assert.notEqual(second.turns[1], first.turns[1]);
  assert.match(second.turns[1]?.fingerprint ?? "", /rev:2/);
});

test("conversation stream reuses unchanged item identities across fresh render model snapshots", () => {
  const firstSnapshot: ChatRenderModel = {
    session_id: "sess_1",
    host: { kind: "desktop_web" },
    rows: [
      {
        kind: "user_message",
        id: "u1",
        key: "user:u1",
        text: "hello",
        copy_text: "hello",
        collapsed: false,
        parts: [{ id: "u1:part:0", type: "text", text: "hello" }],
        createdAt: "2026-06-18T00:00:00Z",
        debug: { projection: "transcript", source_event_ids: ["evt_1"] },
      },
      {
        kind: "assistant_message",
        id: "a1",
        key: "assistant:a1",
        blocks: [{ id: "a1:block:0", text: "old" }],
        createdAt: "2026-06-18T00:00:01Z",
        status: "streaming",
        streaming: true,
        revision: 1,
        debug: { projection: "transcript", source_event_ids: ["evt_2"] },
      },
    ],
    composer: { placeholder: "要求后续变更", can_send: true },
  };
  const secondSnapshot: ChatRenderModel = {
    ...firstSnapshot,
    rows: [
      { ...firstSnapshot.rows[0]! },
      {
        ...firstSnapshot.rows[1]!,
        blocks: [{ id: "a1:block:0", text: "older" }],
        revision: 2,
      },
    ],
  };

  const firstItems = buildConversationStreamItems(toWebChatModel(firstSnapshot).turns);
  const secondItems = buildConversationStreamItems(toWebChatModel(secondSnapshot).turns);

  assert.equal(secondItems[0], firstItems[0]);
  assert.notEqual(secondItems[1], firstItems[1]);
});

test("user image parts stay renderable in web blocks", () => {
  const model: ChatRenderModel = {
    session_id: "sess_1",
    host: { kind: "desktop_web" },
    rows: [
      {
        kind: "user_message",
        id: "u1",
        key: "user:u1",
        text: "look",
        copy_text: "look",
        collapsed: false,
        parts: [
          { id: "u1:part:0", type: "text", text: "look" },
          {
            id: "u1:part:1",
            type: "image",
            data: { mime_type: "image/png", data: "aGVsbG8=", size_bytes: 5 },
          },
        ],
        createdAt: "2026-06-18T00:00:00Z",
        debug: { projection: "transcript", source_event_ids: ["evt_1"] },
      },
    ],
    composer: { placeholder: "要求后续变更", can_send: true },
  };

  const webModel = toWebChatModel(model);

  assert.equal(webModel.turns[0]?.blocks[0]?.kind, "user_message");
  if (webModel.turns[0]?.blocks[0]?.kind === "user_message") {
    assert.equal(webModel.turns[0].blocks[0].parts[1]?.type, "image");
    assert.equal(webModel.turns[0].blocks[0].parts[1]?.data?.data, "aGVsbG8=");
  }
});

test("conversation runtime keeps small histories on the plain mounted path", () => {
  const turns = [turn("one"), turn("two")];
  const items = buildConversationStreamItems(turns);

  const segments = buildConversationRuntimeSegments(items, DEFAULT_CONVERSATION_RUNTIME_POLICY);

  assert.equal(segments.historyVirtualized.length, 0);
  assert.deepEqual(segments.historyMounted.map((item) => item.id), ["one", "two"]);
  assert.equal(segments.liveHead.length, 0);
  assert.equal(segments.boundary.hasVirtualizedHistory, false);
});

test("conversation runtime memoizes stream items for unchanged turn arrays", () => {
  const turns = [turn("one"), turn("two")];

  assert.equal(buildConversationStreamItems(turns), buildConversationStreamItems(turns));
});

test("conversation runtime memoizes segment splits for unchanged item arrays and policy", () => {
  const items = buildConversationStreamItems(
    Array.from({ length: 8 }, (_, index) => turn(`turn-${index + 1}`)),
  );

  assert.equal(
    buildConversationRuntimeSegments(items, {
      virtualizeAfterItemCount: 5,
      mountedRecentItemCount: 3,
    }),
    buildConversationRuntimeSegments(items, {
      virtualizeAfterItemCount: 5,
      mountedRecentItemCount: 3,
    }),
  );
});

test("conversation runtime uses Paseo-style item thresholds by default", () => {
  assert.equal(DEFAULT_CONVERSATION_RUNTIME_POLICY.virtualizeAfterItemCount, 100);
  assert.equal(DEFAULT_CONVERSATION_RUNTIME_POLICY.mountedRecentItemCount, 50);

  const belowThreshold = buildConversationStreamItems(
    Array.from({ length: 100 }, (_, index) => turn(`below-${index + 1}`)),
  );
  const atThreshold = buildConversationRuntimeSegments(
    belowThreshold,
    DEFAULT_CONVERSATION_RUNTIME_POLICY,
  );

  assert.equal(atThreshold.historyVirtualized.length, 0);
  assert.equal(atThreshold.historyMounted.length, 100);

  const aboveThreshold = buildConversationStreamItems(
    Array.from({ length: 101 }, (_, index) => turn(`above-${index + 1}`)),
  );
  const split = buildConversationRuntimeSegments(
    aboveThreshold,
    DEFAULT_CONVERSATION_RUNTIME_POLICY,
  );

  assert.equal(split.historyVirtualized.length, 51);
  assert.equal(split.historyMounted.length, 50);
  assert.equal(split.historyMounted[0]?.id, "above-52");
});

test("conversation runtime summary proves thousand-row histories stay partially virtualized", () => {
  const items = buildConversationStreamItems(
    Array.from({ length: 2_500 }, (_, index) => turn(`long-${index + 1}`)),
  );
  const segments = buildConversationRuntimeSegments(
    items,
    DEFAULT_CONVERSATION_RUNTIME_POLICY,
  );

  assert.deepEqual(summarizeConversationRuntime(items, segments), {
    strategy: "web-partial-virtualized",
    itemCount: 2_500,
    historyVirtualizedCount: 2_450,
    historyMountedCount: 50,
    liveHeadCount: 0,
    mountedItemCount: 50,
  });
});

test("conversation runtime policy is host-aware before choosing a list strategy", () => {
  const items = buildConversationStreamItems(
    Array.from({ length: 101 }, (_, index) => turn(`host-${index + 1}`)),
  );

  const desktopSegments = buildConversationRuntimeSegments(
    items,
    conversationRuntimePolicyForHost("desktop_web"),
  );
  const mobileSegments = buildConversationRuntimeSegments(
    items,
    conversationRuntimePolicyForHost("mobile_web"),
  );

  assert.equal(desktopSegments.boundary.hasVirtualizedHistory, true);
  assert.equal(desktopSegments.historyVirtualized.length, 51);
  assert.equal(mobileSegments.boundary.hasVirtualizedHistory, true);
  assert.equal(mobileSegments.historyVirtualized.length, 51);
  assert.equal(mobileSegments.historyMounted.length, 50);
});

test("conversation strategy resolver centralizes host-aware list strategy names", () => {
  const items = buildConversationStreamItems(
    Array.from({ length: 101 }, (_, index) => turn(`strategy-${index + 1}`)),
  );
  const desktopSegments = buildConversationRuntimeSegments(
    items,
    conversationRuntimePolicyForHost("desktop_web"),
  );
  const mobileSegments = buildConversationRuntimeSegments(
    items,
    conversationRuntimePolicyForHost("mobile_web"),
  );

  assert.equal(
    resolveConversationStrategyName({
      hostKind: "desktop_web",
      segments: desktopSegments,
    }),
    "web-partial-virtualized",
  );
  assert.equal(
    resolveConversationStrategyName({
      hostKind: "mobile_web",
      segments: desktopSegments,
    }),
    "web-partial-virtualized",
  );
  assert.equal(
    resolveConversationStrategyName({
      hostKind: "desktop_web",
      segments: mobileSegments,
    }),
    "web-partial-virtualized",
  );
});

test("conversation runtime supports E2E overrides for virtualization thresholds", () => {
  const globalWithOverrides = globalThis as typeof globalThis & {
    __VELA_E2E_CONVERSATION_MOUNTED_RECENT_ITEM_COUNT?: unknown;
    __VELA_E2E_CONVERSATION_VIRTUALIZE_AFTER_ITEM_COUNT?: unknown;
  };
  const previousVirtualizeAfter =
    globalWithOverrides.__VELA_E2E_CONVERSATION_VIRTUALIZE_AFTER_ITEM_COUNT;
  const previousMountedRecent =
    globalWithOverrides.__VELA_E2E_CONVERSATION_MOUNTED_RECENT_ITEM_COUNT;

  try {
    globalWithOverrides.__VELA_E2E_CONVERSATION_VIRTUALIZE_AFTER_ITEM_COUNT = 6;
    globalWithOverrides.__VELA_E2E_CONVERSATION_MOUNTED_RECENT_ITEM_COUNT = 4;

    const defaultedSegments = buildConversationRuntimeSegments(
      buildConversationStreamItems(
        Array.from({ length: 8 }, (_, index) => turn(`override-${index + 1}`)),
      ),
    );

    assert.equal(defaultedSegments.historyVirtualized.length, 4);
    assert.equal(defaultedSegments.historyMounted.length, 4);

    const explicitSegments = buildConversationRuntimeSegments(
      buildConversationStreamItems(
        Array.from({ length: 8 }, (_, index) => turn(`explicit-${index + 1}`)),
      ),
      {
        virtualizeAfterItemCount: 5,
        mountedRecentItemCount: 3,
      },
    );

    assert.equal(explicitSegments.historyVirtualized.length, 5);
    assert.equal(explicitSegments.historyMounted.length, 3);
  } finally {
    if (previousVirtualizeAfter === undefined) {
      delete globalWithOverrides.__VELA_E2E_CONVERSATION_VIRTUALIZE_AFTER_ITEM_COUNT;
    } else {
      globalWithOverrides.__VELA_E2E_CONVERSATION_VIRTUALIZE_AFTER_ITEM_COUNT =
        previousVirtualizeAfter;
    }
    if (previousMountedRecent === undefined) {
      delete globalWithOverrides.__VELA_E2E_CONVERSATION_MOUNTED_RECENT_ITEM_COUNT;
    } else {
      globalWithOverrides.__VELA_E2E_CONVERSATION_MOUNTED_RECENT_ITEM_COUNT =
        previousMountedRecent;
    }
  }
});

test("conversation runtime retains a recent mounted item window when history is long", () => {
  const turns = Array.from({ length: 8 }, (_, index) => turn(`turn-${index + 1}`));
  const items = buildConversationStreamItems(turns);

  const segments = buildConversationRuntimeSegments(items, {
    virtualizeAfterItemCount: 5,
    mountedRecentItemCount: 3,
  });

  assert.deepEqual(segments.historyVirtualized.map((item) => item.id), [
    "turn-1",
    "turn-2",
    "turn-3",
    "turn-4",
    "turn-5",
  ]);
  assert.deepEqual(segments.historyMounted.map((item) => item.id), [
    "turn-6",
    "turn-7",
    "turn-8",
  ]);
  assert.equal(segments.liveHead.length, 0);
});

test("conversation runtime starts the mounted recent window at a user message boundary", () => {
  const items = buildConversationStreamItems([
    userMessageTurn("u1"),
    turn("a1"),
    turn("tool-1"),
    userMessageTurn("u2"),
    turn("a2"),
    turn("tool-2"),
    turn("a3"),
  ]);

  const segments = buildConversationRuntimeSegments(items, {
    virtualizeAfterItemCount: 4,
    mountedRecentItemCount: 2,
  });

  assert.deepEqual(segments.historyVirtualized.map((item) => item.id), [
    "u1",
    "a1",
    "tool-1",
  ]);
  assert.deepEqual(segments.historyMounted.map((item) => item.id), [
    "u2",
    "a2",
    "tool-2",
    "a3",
  ]);
});

test("history paging triggers near the top threshold only when older history is available", () => {
  assert.equal(DEFAULT_HISTORY_START_THRESHOLD_PX, 96);
  assert.equal(
    shouldRequestOlderHistory({
      hasOlderHistory: true,
      isLoadingOlderHistory: false,
      scrollTop: 96,
    }),
    true,
  );
  assert.equal(
    shouldRequestOlderHistory({
      hasOlderHistory: true,
      isLoadingOlderHistory: false,
      scrollTop: 97,
    }),
    false,
  );
  assert.equal(
    shouldRequestOlderHistory({
      hasOlderHistory: false,
      isLoadingOlderHistory: false,
      scrollTop: 0,
    }),
    false,
  );
  assert.equal(
    shouldRequestOlderHistory({
      hasOlderHistory: true,
      isLoadingOlderHistory: true,
      scrollTop: 0,
    }),
    false,
  );
});

test("history paging waits for the viewport to settle before the first older-history request", () => {
  assert.equal(
    shouldRequestOlderHistory({
      hasOlderHistory: true,
      isHistoryStartReady: false,
      isLoadingOlderHistory: false,
      scrollTop: 0,
    }),
    false,
  );
  assert.equal(
    shouldRequestOlderHistory({
      hasOlderHistory: true,
      isHistoryStartReady: true,
      isLoadingOlderHistory: false,
      scrollTop: 0,
    }),
    true,
  );
});

test("history prepend preserves viewport by offsetting the scroll height delta", () => {
  assert.equal(
    deriveScrollTopAfterHistoryPrepend({
      previousScrollHeight: 1200,
      previousScrollTop: 40,
      scrollHeight: 1500,
    }),
    340,
  );
  assert.equal(
    deriveScrollTopAfterHistoryPrepend({
      previousScrollHeight: 1500,
      previousScrollTop: 40,
      scrollHeight: 1200,
    }),
    40,
  );
});

test("conversation scroll resume keeps storage session-scoped and validates payloads", () => {
  const state = {
    routeKey: "sess/with spaces",
    scrollTop: 420.5,
    followOutput: false,
  };
  const serialized = serializeConversationScrollResumeState(state);

  assert.equal(
    buildConversationScrollResumeStorageKey(state.routeKey),
    "vela-chat:conversation-scroll:sess%2Fwith%20spaces",
  );
  assert.deepEqual(parseConversationScrollResumeState(serialized, state.routeKey), state);
  assert.equal(parseConversationScrollResumeState(serialized, "other-session"), null);
  assert.equal(parseConversationScrollResumeState("not-json", state.routeKey), null);
  assert.equal(
    parseConversationScrollResumeState(
      JSON.stringify({
        version: 1,
        route_key: state.routeKey,
        scroll_top: -1,
        follow_output: false,
      }),
      state.routeKey,
    ),
    null,
  );
});

test("conversation scroll resume restores only detached positions after layout is measurable", () => {
  assert.deepEqual(
    deriveConversationScrollResumeDecision({
      contentHeight: 1400,
      isHistoryReady: false,
      pendingVerification: false,
      resumeState: {
        routeKey: "sess_1",
        scrollTop: 600,
        followOutput: false,
      },
      viewportHeight: 500,
      viewportWidth: 900,
    }),
    {
      blockedReason: "waiting_for_history_readiness",
      shouldRestore: false,
      scrollTop: null,
    },
  );
  assert.deepEqual(
    deriveConversationScrollResumeDecision({
      contentHeight: 1400,
      isHistoryReady: true,
      pendingVerification: false,
      resumeState: {
        routeKey: "sess_1",
        scrollTop: 1200,
        followOutput: false,
      },
      viewportHeight: 500,
      viewportWidth: 900,
    }),
    {
      blockedReason: null,
      shouldRestore: true,
      scrollTop: 900,
    },
  );
  assert.deepEqual(
    deriveConversationScrollResumeDecision({
      contentHeight: 1400,
      isHistoryReady: true,
      pendingVerification: false,
      resumeState: {
        routeKey: "sess_1",
        scrollTop: 1200,
        followOutput: true,
      },
      viewportHeight: 500,
      viewportWidth: 900,
    }),
    {
      blockedReason: null,
      shouldRestore: false,
      scrollTop: null,
    },
  );
});

test("bottom anchor stays sticky when streaming content growth moves the viewport away from bottom", () => {
  const result = deriveBottomAnchorFollowState({
    clientHeight: 400,
    followOutput: true,
    previousScrollTop: 800,
    scrollHeight: 1400,
    scrollTop: 800,
    userScrollActive: false,
  });

  assert.equal(result.followOutput, true);
  assert.equal(result.pendingUserScrollUpIntent, false);
});

test("bottom anchor detaches only when sticky user scrolls upward intentionally", () => {
  const result = deriveBottomAnchorFollowState({
    clientHeight: 400,
    followOutput: true,
    pendingUserScrollUpIntent: true,
    previousScrollTop: 800,
    scrollHeight: 1200,
    scrollTop: 800 - USER_SCROLL_DELTA_EPSILON - 1,
    userScrollActive: true,
  });

  assert.equal(result.followOutput, false);
  assert.equal(result.pendingUserScrollUpIntent, false);
});

test("bottom anchor resumes sticky mode only after reaching the actual bottom", () => {
  assert.equal(
    deriveBottomAnchorFollowState({
      clientHeight: 400,
      followOutput: false,
      previousScrollTop: 700,
      scrollHeight: 1200,
      scrollTop: 799,
      userScrollActive: true,
    }).followOutput,
    true,
  );
  assert.equal(
    deriveBottomAnchorFollowState({
      clientHeight: 400,
      followOutput: false,
      previousScrollTop: 700,
      scrollHeight: 1200,
      scrollTop: 760,
      userScrollActive: true,
    }).followOutput,
    false,
  );
});

test("bottom anchor route requests expose blocked reasons before attempting to scroll", () => {
  assert.deepEqual(
    deriveBottomAnchorRouteReadiness({
      contentHeight: 1200,
      isHistoryReady: false,
      pendingVerification: false,
      requestKey: "session:a",
      viewportHeight: 600,
      viewportWidth: 900,
    }),
    {
      blockedReason: "waiting_for_history_readiness",
      canAttempt: false,
    },
  );
  assert.deepEqual(
    deriveBottomAnchorRouteReadiness({
      contentHeight: 1200,
      isHistoryReady: true,
      pendingVerification: false,
      requestKey: "session:a",
      viewportHeight: 0,
      viewportWidth: 900,
    }),
    {
      blockedReason: "waiting_for_measurable_viewport",
      canAttempt: false,
    },
  );
  assert.deepEqual(
    deriveBottomAnchorRouteReadiness({
      contentHeight: 0,
      isHistoryReady: true,
      pendingVerification: false,
      requestKey: "session:a",
      viewportHeight: 600,
      viewportWidth: 900,
    }),
    {
      blockedReason: "waiting_for_measurable_content",
      canAttempt: false,
    },
  );
  assert.deepEqual(
    deriveBottomAnchorRouteReadiness({
      contentHeight: 1200,
      isHistoryReady: true,
      pendingVerification: true,
      requestKey: "session:a",
      viewportHeight: 600,
      viewportWidth: 900,
    }),
    {
      blockedReason: "waiting_for_post_layout_verification",
      canAttempt: false,
    },
  );
  assert.deepEqual(
    deriveBottomAnchorRouteReadiness({
      contentHeight: 1200,
      isHistoryReady: true,
      pendingVerification: false,
      requestKey: "session:a",
      viewportHeight: 600,
      viewportWidth: 900,
    }),
    {
      blockedReason: null,
      canAttempt: true,
    },
  );
});

test("bottom anchor resticks on content growth only while following output", () => {
  assert.equal(
    shouldRestickOnContentSizeChange({
      followOutput: true,
      previousContentHeight: 1200,
      contentHeight: 1280,
    }),
    true,
  );
  assert.equal(
    shouldRestickOnContentSizeChange({
      followOutput: false,
      previousContentHeight: 1200,
      contentHeight: 1280,
    }),
    false,
  );
  assert.equal(
    shouldRestickOnContentSizeChange({
      followOutput: true,
      previousContentHeight: 1280,
      contentHeight: 1200,
    }),
    false,
  );
});

test("bottom anchor resticks on viewport resize only while following output", () => {
  assert.equal(
    shouldRestickOnViewportSizeChange({
      followOutput: true,
      previousViewportHeight: 720,
      previousViewportWidth: 1280,
      viewportHeight: 680,
      viewportWidth: 1280,
    }),
    true,
  );
  assert.equal(
    shouldRestickOnViewportSizeChange({
      followOutput: false,
      previousViewportHeight: 720,
      previousViewportWidth: 1280,
      viewportHeight: 680,
      viewportWidth: 1280,
    }),
    false,
  );
  assert.equal(
    shouldRestickOnViewportSizeChange({
      followOutput: true,
      previousViewportHeight: 720,
      previousViewportWidth: 1280,
      viewportHeight: 720,
      viewportWidth: 1280,
    }),
    false,
  );
});

test("bottom anchor retries after layout settle only when still following and not near bottom", () => {
  assert.equal(
    shouldRetryBottomStickAfterSettle({
      clientHeight: 400,
      followOutput: true,
      scrollHeight: 1400,
      scrollTop: 500,
    }),
    true,
  );
  assert.equal(
    shouldRetryBottomStickAfterSettle({
      clientHeight: 400,
      followOutput: true,
      scrollHeight: 1000,
      scrollTop: 600,
    }),
    false,
  );
  assert.equal(
    shouldRetryBottomStickAfterSettle({
      clientHeight: 400,
      followOutput: false,
      scrollHeight: 1400,
      scrollTop: 500,
    }),
    false,
  );
});

test("bottom anchor detects browser overscroll past the visual bottom", async () => {
  const bottomAnchor = (await import(
    "../src/conversation-runtime/scroll/bottomAnchor"
  )) as typeof import("../src/conversation-runtime/scroll/bottomAnchor") & {
    isOverscrolledPastBottom?: (input: {
      clientHeight: number;
      scrollHeight: number;
      scrollTop: number;
    }) => boolean;
  };

  assert.equal(typeof bottomAnchor.isOverscrolledPastBottom, "function");
  assert.equal(
    bottomAnchor.isOverscrolledPastBottom?.({
      clientHeight: 400,
      scrollHeight: 1000,
      scrollTop: 621,
    }),
    true,
  );
  assert.equal(
    bottomAnchor.isOverscrolledPastBottom?.({
      clientHeight: 400,
      scrollHeight: 1000,
      scrollTop: 600,
    }),
    false,
  );
  assert.equal(
    bottomAnchor.isOverscrolledPastBottom?.({
      clientHeight: 400,
      scrollHeight: 1000,
      scrollTop: Number.NaN,
    }),
    false,
  );
});

test("bottom anchor cancels pending stick when user starts scrolling upward", () => {
  assert.equal(
    shouldCancelPendingStickForUserScrollIntent({ scrollUpIntent: true }),
    true,
  );
  assert.equal(
    shouldCancelPendingStickForUserScrollIntent({ scrollUpIntent: false }),
    false,
  );
});

function userMessageTurn(id: string): WebTurn {
  return {
    id,
    key: `turn:${id}`,
    fingerprint: `turn:${id}`,
    live: false,
    blocks: [
      {
        kind: "user_message",
        id,
        key: `user:${id}`,
        text: id,
        copyText: id,
        parts: [{ id: `${id}:part:0`, type: "text", text: id }],
        createdAt: "2026-06-18T00:00:00Z",
      },
    ],
  };
}
