import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import type { TimelineBlock } from "@opencraft/chat-core";
import {
  TimelineBlockRendererRegistryService,
  type TimelineBlockRendererRegistration,
} from "@opencraft/timeline-render-react";

const textBlock = {
  id: "text-1",
  phase: "final_answer",
  streaming: false,
  text: "hello",
  type: "text",
} as TimelineBlock;

const component = () => null;

test("Timeline renderer registry is priority ordered, replaceable and reversible", async () => {
  const context = new Context();
  const fiber = context.plugin(TimelineBlockRendererRegistryService);
  await fiber;
  const fallback: TimelineBlockRendererRegistration = {
    name: "fallback-text",
    priority: 0,
    types: ["text"],
    component,
  };
  const product: TimelineBlockRendererRegistration = {
    name: "product-text",
    priority: 100,
    types: ["text"],
    matches: (block) => block.type === "text" && block.phase === "final_answer",
    component,
  };
  const removeFallback = context.timelineBlockRenderers.register(fallback);
  const removeProduct = context.timelineBlockRenderers.register(product);
  assert.equal(
    context.timelineBlockRenderers.resolve(
      context.timelineBlockRenderers.getSnapshot(),
      textBlock,
    )?.name,
    "product-text",
  );
  removeProduct();
  assert.equal(
    context.timelineBlockRenderers.resolve(
      context.timelineBlockRenderers.getSnapshot(),
      textBlock,
    )?.name,
    "fallback-text",
  );
  removeFallback();
  assert.equal(
    context.timelineBlockRenderers.resolve(
      context.timelineBlockRenderers.getSnapshot(),
      textBlock,
    ),
    null,
  );
  await fiber.dispose();
});
