import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  activityAccessibleLabel,
  activityVisualStatus,
  activityVisualSummary,
} from "../src/renderers/blocks/activityLabel";

const root = process.cwd();

test("activity accessible labels preserve full tool summaries without duplicated generic text", () => {
  assert.equal(
    activityAccessibleLabel({
      kind: "agent_work",
      id: "tool_1",
      key: "tool:tool_1",
      title: "Ran command",
      summary: 'curl -s -o /tmp/image.jpg "https://example.com/very/long/path/image.jpg"',
      status: "completed",
      display: "prominent",
      createdAt: "2026-06-20T00:00:00Z",
    }),
    'Ran command: curl -s -o /tmp/image.jpg "https://example.com/very/long/path/image.jpg"',
  );

  assert.equal(
    activityAccessibleLabel({
      kind: "agent_work",
      id: "tool_2",
      key: "tool:tool_2",
      title: "Read file",
      summary: "Read file",
      status: "completed",
      display: "compact",
      createdAt: "2026-06-20T00:00:00Z",
    }),
    "Read file",
  );

  assert.equal(
    activityAccessibleLabel({
      kind: "status",
      id: "status_1",
      key: "status:status_1",
      label: "处理失败：backend unavailable",
      createdAt: "2026-06-20T00:00:00Z",
    }),
    "处理失败：backend unavailable",
  );
});

test("activity renderer exposes full labels to hover and assistive technology", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/blocks/ActivityRenderer.tsx"),
    "utf8",
  );

  assert.match(source, /activityAccessibleLabel/);
  assert.match(source, /aria-label=\{label\}/);
  assert.match(source, /title=\{label\}/);
});

test("activity renderer uses quiet work-log icons instead of orange bullet dots", () => {
  const renderer = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/blocks/ActivityRenderer.tsx"),
    "utf8",
  );
  const styles = readFileSync(
    join(root, "packages/vela-chat-web/src/styles/desktop.module.css"),
    "utf8",
  );

  assert.match(renderer, /activityIcon/);
  assert.doesNotMatch(renderer, /activityDot/);
  assert.doesNotMatch(styles, /\.activityDot/);
  assert.doesNotMatch(styles, /#df7048/);
});

test("activity visual summaries omit duplicate generic text", () => {
  assert.equal(activityVisualSummary("Read file", "Read file"), "");
  assert.equal(activityVisualSummary("README.md", "Read file"), "README.md");

  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/blocks/ActivityRenderer.tsx"),
    "utf8",
  );

  assert.match(source, /activityVisualSummary/);
  assert.match(source, /const summary = activityVisualSummary\(block\.summary,\s*block\.title\);/);
  assert.doesNotMatch(source, /block\.summary \? <span className=\{styles\.activitySummary\}>\{block\.summary\}/);
});

test("failed activity status rows expose failed visual status", () => {
  const activityLabel = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/blocks/activityLabel.ts"),
    "utf8",
  );
  const activityRenderer = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/blocks/ActivityRenderer.tsx"),
    "utf8",
  );

  assert.match(activityLabel, /export function activityVisualStatus/);
  assert.match(activityLabel, /block\.label\.startsWith\("处理失败："\)/);
  assert.match(activityRenderer, /const status = activityVisualStatus\(block\);/);
  assert.match(activityRenderer, /data-status=\{status\}/);
});

test("status rows use explicit render status for failed visual state", () => {
  assert.equal(
    activityVisualStatus({
      kind: "status",
      id: "status_failed",
      key: "status:failed",
      label: "Backend unavailable",
      status: "failed",
      createdAt: "2026-06-20T00:00:00Z",
    } as Parameters<typeof activityVisualStatus>[0]),
    "failed",
  );
});
