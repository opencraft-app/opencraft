import assert from "node:assert/strict";
import test from "node:test";

import {
  createIncomingLiveTextBufferState,
  createLiveTextBufferState,
  hasPendingLiveText,
  setLiveTextBufferTarget,
  stepLiveTextBuffer,
} from "../src/renderers/markdown/liveTextBuffer";

test("live text buffer reveals a growing streaming target gradually", () => {
  let state = createLiveTextBufferState("");
  state = setLiveTextBufferTarget(state, "abcdefghijklmnopqrstuvwxyz", "streaming");

  state = stepLiveTextBuffer(state, 16, {
    maxUnitsPerSecond: 60,
    minUnitsPerSecond: 60,
    targetLatencyMs: 120,
  });
  state = stepLiveTextBuffer(state, 84, {
    maxUnitsPerSecond: 60,
    minUnitsPerSecond: 60,
    targetLatencyMs: 120,
  });

  assert.equal(state.visibleText.length > 0, true);
  assert.equal(state.visibleText.length < state.targetText.length, true);
  assert.equal(hasPendingLiveText(state), true);
});

test("live text buffer releases streaming text in small frame slices", () => {
  let state = createLiveTextBufferState("");
  state = setLiveTextBufferTarget(
    state,
    "这是一段很长的中文流式文本，不能在单帧里一整坨跳出来。",
    "streaming",
  );

  state = stepLiveTextBuffer(state, 33);

  assert.ok(
    state.visibleUnitCount <= 4,
    `expected at most 4 visible units in one frame, got ${state.visibleUnitCount}`,
  );
});

test("live text buffer follows a 500 character stream at roughly 50 characters per second", () => {
  const finalText = "流".repeat(500);
  let state = createLiveTextBufferState("");
  const frameMs = 20;
  const perSecondDeltas: number[] = [];
  let previousVisibleCount = 0;

  for (let nowMs = 0; nowMs <= 10_000; nowMs += frameMs) {
    const targetLength = Math.min(500, Math.floor((nowMs / 1000) * 50));
    state = setLiveTextBufferTarget(
      state,
      finalText.slice(0, targetLength),
      "streaming",
    );
    state = stepLiveTextBuffer(state, frameMs, {
      maxUnitsPerFrame: 4,
      maxUnitsPerSecond: 80,
      minUnitsPerSecond: 28,
      targetLatencyMs: 130,
    });

    if (nowMs > 0 && nowMs % 1000 === 0) {
      const delta = state.visibleUnitCount - previousVisibleCount;
      perSecondDeltas.push(delta);
      previousVisibleCount = state.visibleUnitCount;
      assert.ok(
        targetLength - state.visibleUnitCount <= 12,
        `expected small output backlog at ${nowMs}ms, got ${targetLength - state.visibleUnitCount}`,
      );
    }
  }

  assert.equal(perSecondDeltas.length, 10);
  for (const [index, delta] of perSecondDeltas.entries()) {
    assert.ok(
      delta >= 40 && delta <= 55,
      `expected second ${index + 1} to avoid throughput spikes or stalls, got ${delta}`,
    );
  }
  const averageDelta = perSecondDeltas.reduce((sum, delta) => sum + delta, 0) /
    perSecondDeltas.length;
  assert.ok(
    averageDelta >= 48 && averageDelta <= 52,
    `expected average output rate to stay near 50 chars/s, got ${averageDelta}`,
  );

  state = setLiveTextBufferTarget(state, finalText, "settling");
  state = stepLiveTextBuffer(state, 200, { settlingLatencyMs: 200 });
  assert.equal(state.visibleText, finalText);
});

test("live text buffer paces coarse backend chunks using recent input cadence", () => {
  const finalText = "流".repeat(150);
  let state = createLiveTextBufferState("");

  state = setLiveTextBufferTarget(state, finalText.slice(0, 50), "streaming");
  for (let elapsedMs = 0; elapsedMs < 1000; elapsedMs += 20) {
    state = stepLiveTextBuffer(state, 20);
  }
  assert.ok(
    state.visibleUnitCount >= 46 && state.visibleUnitCount < 50,
    `expected first chunk to keep a small reserve, got ${state.visibleUnitCount}`,
  );

  state = setLiveTextBufferTarget(state, finalText.slice(0, 100), "streaming");
  for (let elapsedMs = 0; elapsedMs < 500; elapsedMs += 20) {
    state = stepLiveTextBuffer(state, 20);
  }

  assert.ok(
    state.visibleUnitCount > 60,
    `expected visible text to keep moving, got ${state.visibleUnitCount}`,
  );
  assert.ok(
    state.visibleUnitCount < 95,
    `expected coarse chunk release to remain paced, got ${state.visibleUnitCount}`,
  );

  for (let elapsedMs = 500; elapsedMs < 1000; elapsedMs += 20) {
    state = stepLiveTextBuffer(state, 20);
  }
  assert.ok(
    state.visibleUnitCount >= 92 && state.visibleUnitCount < 100,
    `expected second chunk to keep a small reserve, got ${state.visibleUnitCount}`,
  );
});

test("live text buffer keeps output velocity smooth when coarse chunks arrive", () => {
  const finalText = "流".repeat(150);
  let state = createLiveTextBufferState("");

  state = setLiveTextBufferTarget(state, finalText.slice(0, 50), "streaming");
  for (let elapsedMs = 0; elapsedMs < 1000; elapsedMs += 20) {
    state = stepLiveTextBuffer(state, 20);
  }

  state = setLiveTextBufferTarget(state, finalText.slice(0, 100), "streaming");
  let previousVisibleCount = state.visibleUnitCount;
  const deltas: number[] = [];
  for (let bucket = 0; bucket < 8; bucket += 1) {
    for (let elapsedMs = 0; elapsedMs < 100; elapsedMs += 20) {
      state = stepLiveTextBuffer(state, 20);
    }
    const delta = state.visibleUnitCount - previousVisibleCount;
    deltas.push(delta);
    previousVisibleCount = state.visibleUnitCount;
  }

  assert.ok(
    deltas[0]! <= 5,
    `expected first 100ms after a chunk to avoid velocity spike, got ${deltas.join(",")}`,
  );
  for (let index = 1; index < deltas.length; index += 1) {
    assert.ok(
      Math.abs(deltas[index]! - deltas[index - 1]!) <= 4,
      `expected adjacent output buckets to change smoothly, got ${deltas.join(",")}`,
    );
  }
});

test("live text buffer keeps output velocity smooth across slow and fast providers", () => {
  const scenarios = [
    {
      chunkUnits: 12,
      intervalMs: 1200,
      maxFirstBucket: 2,
      maxAdjacentChange: 2,
      name: "slow Maas-like provider",
    },
    {
      chunkUnits: 50,
      intervalMs: 1000,
      maxFirstBucket: 5,
      maxAdjacentChange: 4,
      name: "medium provider",
    },
    {
      chunkUnits: 120,
      intervalMs: 1000,
      maxFirstBucket: 14,
      maxAdjacentChange: 5,
      name: "fast local provider",
    },
  ];

  for (const scenario of scenarios) {
    const finalText = "流".repeat(scenario.chunkUnits * 3);
    let state = createLiveTextBufferState("");

    state = setLiveTextBufferTarget(
      state,
      finalText.slice(0, scenario.chunkUnits),
      "streaming",
    );
    for (let elapsedMs = 0; elapsedMs < scenario.intervalMs; elapsedMs += 20) {
      state = stepLiveTextBuffer(state, 20);
    }

    state = setLiveTextBufferTarget(
      state,
      finalText.slice(0, scenario.chunkUnits * 2),
      "streaming",
    );
    let previousVisibleCount = state.visibleUnitCount;
    const deltas: number[] = [];
    for (let bucket = 0; bucket < 8; bucket += 1) {
      for (let elapsedMs = 0; elapsedMs < 100; elapsedMs += 20) {
        state = stepLiveTextBuffer(state, 20);
      }
      const delta = state.visibleUnitCount - previousVisibleCount;
      deltas.push(delta);
      previousVisibleCount = state.visibleUnitCount;
    }

    assert.ok(
      deltas[0]! <= scenario.maxFirstBucket,
      `${scenario.name}: expected first bucket to avoid provider chunk spike, got ${deltas.join(",")}`,
    );
    for (let index = 1; index < deltas.length; index += 1) {
      assert.ok(
        Math.abs(deltas[index]! - deltas[index - 1]!) <= scenario.maxAdjacentChange,
        `${scenario.name}: expected adjacent bucket deltas to change smoothly, got ${deltas.join(",")}`,
      );
    }
  }
});

test("live text buffer keeps output velocity smooth when provider speed changes mid-stream", () => {
  const scenarios = [
    {
      chunks: [
        { intervalMs: 600, units: 72 },
        { intervalMs: 1400, units: 14 },
        { intervalMs: 1400, units: 14 },
      ],
      maxFirstBucketByChunk: [14, 12],
      name: "fast then slow",
    },
    {
      chunks: [
        { intervalMs: 1400, units: 14 },
        { intervalMs: 600, units: 72 },
        { intervalMs: 600, units: 72 },
      ],
      maxFirstBucketByChunk: [3, 8],
      name: "slow then fast",
    },
  ];

  for (const scenario of scenarios) {
    const finalText = "流".repeat(
      scenario.chunks.reduce((sum, chunk) => sum + chunk.units, 0),
    );
    let state = createLiveTextBufferState("");
    let targetUnits = 0;

    for (let chunkIndex = 0; chunkIndex < scenario.chunks.length; chunkIndex += 1) {
      const chunk = scenario.chunks[chunkIndex]!;
      targetUnits += chunk.units;
      state = setLiveTextBufferTarget(
        state,
        finalText.slice(0, targetUnits),
        "streaming",
      );

      const previousVisibleCount = state.visibleUnitCount;
      const deltas: number[] = [];
      for (let bucket = 0; bucket < Math.min(8, Math.ceil(chunk.intervalMs / 100)); bucket += 1) {
        for (let elapsedMs = 0; elapsedMs < 100; elapsedMs += 20) {
          state = stepLiveTextBuffer(state, 20);
        }
        const lastVisibleCount = bucket === 0
          ? previousVisibleCount
          : previousVisibleCount + deltas.reduce((sum, delta) => sum + delta, 0);
        deltas.push(state.visibleUnitCount - lastVisibleCount);
      }

      if (chunkIndex > 0) {
        assert.ok(
          deltas[0]! <= scenario.maxFirstBucketByChunk[chunkIndex - 1]!,
          `${scenario.name}: expected chunk ${chunkIndex + 1} first bucket to avoid speed-change spike, got ${deltas.join(",")}`,
        );
      }
      for (let index = 1; index < deltas.length; index += 1) {
        assert.ok(
          Math.abs(deltas[index]! - deltas[index - 1]!) <= 5,
          `${scenario.name}: expected chunk ${chunkIndex + 1} adjacent bucket deltas to change smoothly, got ${deltas.join(",")}`,
        );
      }

      for (let elapsedMs = deltas.length * 100; elapsedMs < chunk.intervalMs; elapsedMs += 20) {
        state = stepLiveTextBuffer(state, 20);
      }
    }
  }
});

test("live text buffer slows down near the target backlog instead of draining dry", () => {
  const finalText = "流".repeat(120);
  let state = createLiveTextBufferState("");

  state = setLiveTextBufferTarget(state, finalText.slice(0, 50), "streaming");
  for (let elapsedMs = 0; elapsedMs < 1000; elapsedMs += 20) {
    state = stepLiveTextBuffer(state, 20);
  }
  state = setLiveTextBufferTarget(state, finalText.slice(0, 100), "streaming");
  for (let elapsedMs = 0; elapsedMs < 1000; elapsedMs += 20) {
    state = stepLiveTextBuffer(state, 20);
  }
  assert.ok(
    state.visibleUnitCount >= 92 && state.visibleUnitCount < 100,
    `expected streaming setup to keep a small reserve, got ${state.visibleUnitCount}`,
  );

  state = setLiveTextBufferTarget(state, finalText.slice(0, 108), "streaming");
  for (let elapsedMs = 0; elapsedMs < 200; elapsedMs += 20) {
    state = stepLiveTextBuffer(state, 20);
  }

  assert.ok(
    state.visibleUnitCount < 108,
    `expected low backlog pacing to keep reserve text, got ${state.visibleUnitCount}`,
  );
});

test("live text buffer keeps a persistent tail reserve while streaming is healthy", () => {
  const finalText = "流".repeat(150);
  let state = createLiveTextBufferState("");

  state = setLiveTextBufferTarget(state, finalText.slice(0, 50), "streaming");
  for (let elapsedMs = 0; elapsedMs < 1000; elapsedMs += 20) {
    state = stepLiveTextBuffer(state, 20);
  }
  const firstBacklog = state.targetUnitCount - state.visibleUnitCount;

  state = setLiveTextBufferTarget(state, finalText.slice(0, 100), "streaming");
  for (let elapsedMs = 0; elapsedMs < 1000; elapsedMs += 20) {
    state = stepLiveTextBuffer(state, 20);
  }
  const secondBacklog = state.targetUnitCount - state.visibleUnitCount;

  assert.ok(firstBacklog > 0, `expected first chunk to keep reserve, got ${firstBacklog}`);
  assert.ok(secondBacklog > 0, `expected second chunk to keep reserve, got ${secondBacklog}`);
  assert.ok(secondBacklog <= 8, `expected a small reserve, got ${secondBacklog}`);
});

test("live text buffer slowly leaks the tail reserve when the stream stalls", () => {
  const finalText = "流".repeat(100);
  let state = createLiveTextBufferState("");

  state = setLiveTextBufferTarget(state, finalText, "streaming");
  for (let elapsedMs = 0; elapsedMs < 1000; elapsedMs += 20) {
    state = stepLiveTextBuffer(state, 20);
  }
  const beforeStallCount = state.visibleUnitCount;
  assert.ok(beforeStallCount < 100, `expected streaming to keep reserve, got ${beforeStallCount}`);

  for (let elapsedMs = 0; elapsedMs < 1200; elapsedMs += 20) {
    state = stepLiveTextBuffer(state, 20);
  }

  assert.ok(
    state.visibleUnitCount > beforeStallCount,
    `expected stalled stream to leak reserve slowly, got ${state.visibleUnitCount}`,
  );
  assert.ok(
    state.visibleUnitCount < 100,
    `expected stalled stream not to flush without completion, got ${state.visibleUnitCount}`,
  );
});

test("live text buffer starts an incoming streaming target hidden", () => {
  const text = "这是一段首次进入视图的流式文本，不能在首帧全量出现。";

  const state = createIncomingLiveTextBufferState(text, "streaming");

  assert.equal(state.targetText, text);
  assert.equal(state.visibleText, "");
  assert.equal(hasPendingLiveText(state), true);
});

test("live text buffer drains a completed stream within the settling window", () => {
  let state = createLiveTextBufferState("");
  state = setLiveTextBufferTarget(state, "one two three four five six", "streaming");
  state = stepLiveTextBuffer(state, 16, {
    maxUnitsPerSecond: 20,
    minUnitsPerSecond: 20,
    targetLatencyMs: 120,
  });
  assert.notEqual(state.visibleText, state.targetText);

  state = setLiveTextBufferTarget(state, state.targetText, "settling");
  state = stepLiveTextBuffer(state, 90, { settlingLatencyMs: 180 });
  assert.equal(hasPendingLiveText(state), true);

  state = stepLiveTextBuffer(state, 90, { settlingLatencyMs: 180 });
  assert.equal(state.visibleText, state.targetText);
  assert.equal(state.phase, "settled");
});

test("live text buffer does not erase visible text when the same stream target regresses", () => {
  let state = createLiveTextBufferState("already visible");
  state = setLiveTextBufferTarget(state, "short", "streaming");

  assert.equal(state.visibleText, "already visible");
  assert.equal(state.targetText, "already visible");
  assert.equal(hasPendingLiveText(state), false);
});

test("live text buffer keeps visible text monotonic when a streaming target is rewritten", () => {
  let state = createLiveTextBufferState("");
  state = setLiveTextBufferTarget(
    state,
    "第一段已经稳定。\n\n第二段正在流式输出。",
    "streaming",
  );
  state = stepLiveTextBuffer(state, 500, {
    maxUnitsPerFrame: 200,
    maxUnitsPerSecond: 200,
    minUnitsPerSecond: 200,
    targetLatencyMs: 120,
  });
  const visibleBeforeRewrite = state.visibleText;
  assert.match(visibleBeforeRewrite, /第二段正在/);

  state = setLiveTextBufferTarget(
    state,
    "第一段已经稳定。\n\n第二段已经变成稳定前缀。\n\n第三段才是新的 live tail。",
    "streaming",
  );

  assert.equal(state.visibleText, visibleBeforeRewrite);
  assert.equal(state.targetText, "第一段已经稳定。\n\n第二段正在流式输出。");
});

test("live text buffer settles the last known target when a completed update regresses", () => {
  let state = createLiveTextBufferState("");
  state = setLiveTextBufferTarget(state, "abcdef", "streaming");
  state = stepLiveTextBuffer(state, 100, {
    maxUnitsPerFrame: 10,
    maxUnitsPerSecond: 100,
    minUnitsPerSecond: 100,
    targetLatencyMs: 120,
  });
  state = setLiveTextBufferTarget(state, "abcdef", "settling");
  state = stepLiveTextBuffer(state, 200, { settlingLatencyMs: 200 });
  assert.equal(state.visibleText, "abcdef");
  assert.equal(state.phase, "settled");

  state = setLiveTextBufferTarget(state, "abcdef", "streaming");
  assert.equal(state.phase, "streaming");

  state = setLiveTextBufferTarget(state, "abc", "settling");

  assert.equal(state.visibleText, "abcdef");
  assert.equal(state.targetText, "abcdef");
  assert.equal(state.phase, "settled");
  assert.equal(hasPendingLiveText(state), false);
});

test("live text buffer slices only at grapheme boundaries", () => {
  let state = createLiveTextBufferState("");
  state = setLiveTextBufferTarget(state, "👨‍👩‍👧‍👦ok", "streaming");
  state = stepLiveTextBuffer(state, 100, {
    maxUnitsPerSecond: 10,
    minUnitsPerSecond: 10,
    targetLatencyMs: 120,
  });

  assert.equal(state.visibleText, "👨‍👩‍👧‍👦");
});

test("live text buffer never drops text across fragmented CJK deltas", () => {
  const finalText = [
    "# 秋夜怀古",
    "",
    "夜色如墨，月光倾泻在古老的城。",
    "",
    "秦时明月依旧",
    "",
    "人生代代无穷已，江月年年望相似。历史的长河淘",
    "",
    "我站在城墙之上，俯瞰这座古老的城市。万家灯火，车水马龙，一",
    "",
    "秋风",
    "",
    "夜深了，我转身离去，心中却多了几分旷远。",
  ].join("\n");
  let state = createLiveTextBufferState("");

  for (let end = 1; end <= finalText.length; end += 5) {
    state = setLiveTextBufferTarget(state, finalText.slice(0, end), "streaming");
    state = stepLiveTextBuffer(state, 33, {
      maxUnitsPerSecond: 40,
      minUnitsPerSecond: 28,
      targetLatencyMs: 130,
    });
    assert.equal(finalText.startsWith(state.visibleText), true);
  }

  state = setLiveTextBufferTarget(state, finalText, "settling");
  state = stepLiveTextBuffer(state, 190, { settlingLatencyMs: 190 });

  assert.equal(state.visibleText, finalText);
  assert.equal(state.phase, "settled");
  assert.equal(hasPendingLiveText(state), false);
});

test("live text buffer settles completed backlog without requiring a new stream delta", () => {
  const finalText = "第一段。\n\n第二段还有很多内容，完成事件到了也不能突然截断或者丢尾巴。";
  let state = createLiveTextBufferState("");
  state = setLiveTextBufferTarget(state, finalText, "streaming");
  state = stepLiveTextBuffer(state, 16, {
    maxUnitsPerSecond: 18,
    minUnitsPerSecond: 18,
    targetLatencyMs: 130,
  });
  assert.notEqual(state.visibleText, finalText);

  state = setLiveTextBufferTarget(state, finalText, "settling");
  for (let elapsed = 0; elapsed < 4; elapsed += 1) {
    state = stepLiveTextBuffer(state, 50, { settlingLatencyMs: 200 });
  }

  assert.equal(state.visibleText, finalText);
  assert.equal(state.phase, "settled");
});

test("live text buffer preserves emoji and punctuation in the completed tail", () => {
  const finalText = "今天是 2026年6月22日，星期一 🗓️\n\n心中却多了几分旷远。";
  let state = createLiveTextBufferState("");

  state = setLiveTextBufferTarget(state, finalText.slice(0, 18), "streaming");
  state = stepLiveTextBuffer(state, 33, {
    maxUnitsPerSecond: 24,
    minUnitsPerSecond: 24,
    targetLatencyMs: 130,
  });
  state = setLiveTextBufferTarget(state, finalText, "settling");
  state = stepLiveTextBuffer(state, 200, { settlingLatencyMs: 200 });

  assert.equal(state.visibleText, finalText);
  assert.match(state.visibleText, /🗓️/);
  assert.match(state.visibleText, /心中却多了几分旷远。/);
});
