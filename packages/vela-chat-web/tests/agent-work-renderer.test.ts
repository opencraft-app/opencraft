import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  agentWorkAccessibleLabel,
  agentWorkVisualStatus,
  agentWorkVisualSummary,
} from "../src/renderers/blocks/agentWorkLabel";

const root = process.cwd();

test("agent work accessible labels preserve full tool summaries without duplicated generic text", () => {
  assert.equal(
    agentWorkAccessibleLabel({
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
    agentWorkAccessibleLabel({
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
    agentWorkAccessibleLabel({
      kind: "status",
      id: "status_1",
      key: "status:status_1",
      label: "处理失败：backend unavailable",
      createdAt: "2026-06-20T00:00:00Z",
    }),
    "处理失败：backend unavailable",
  );
});

test("agent work renderer exposes full labels to hover and assistive technology", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/blocks/AgentWorkRenderer.tsx"),
    "utf8",
  );

  assert.match(source, /agentWorkAccessibleLabel/);
  assert.match(source, /aria-label=\{label\}/);
  assert.match(source, /title=\{label\}/);
});

test("agent work renderer uses quiet work-log icons instead of orange bullet dots", () => {
  const renderer = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/blocks/AgentWorkRenderer.tsx"),
    "utf8",
  );
  const styles = readFileSync(
    join(root, "packages/vela-chat-web/src/styles/desktop.module.css"),
    "utf8",
  );

  assert.match(renderer, /agentWorkIcon/);
  assert.doesNotMatch(renderer, /activityDot/);
  assert.doesNotMatch(styles, /\.activityDot/);
  assert.doesNotMatch(styles, /#df7048/);
});

test("agent work visual summaries omit duplicate generic text", () => {
  assert.equal(agentWorkVisualSummary("Read file", "Read file"), "");
  assert.equal(agentWorkVisualSummary("README.md", "Read file"), "README.md");

  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/blocks/AgentWorkRenderer.tsx"),
    "utf8",
  );

  assert.match(source, /agentWorkVisualSummary/);
  assert.match(source, /const summary = agentWorkVisualSummary\(block\.summary,\s*block\.title\);/);
  assert.doesNotMatch(source, /block\.summary \? <span className=\{styles\.agentWorkSummary\}>\{block\.summary\}/);
});

test("failed agent work status rows expose failed visual status", () => {
  const agentWorkLabel = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/blocks/agentWorkLabel.ts"),
    "utf8",
  );
  const agentWorkRenderer = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/blocks/AgentWorkRenderer.tsx"),
    "utf8",
  );

  assert.match(agentWorkLabel, /export function agentWorkVisualStatus/);
  assert.match(agentWorkLabel, /block\.label\.startsWith\("处理失败："\)/);
  assert.match(agentWorkRenderer, /const status = agentWorkVisualStatus\(block\);/);
  assert.match(agentWorkRenderer, /data-status=\{status\}/);
});

test("status rows use explicit render status for failed visual state", () => {
  assert.equal(
    agentWorkVisualStatus({
      kind: "status",
      id: "status_failed",
      key: "status:failed",
      label: "Backend unavailable",
      status: "failed",
      createdAt: "2026-06-20T00:00:00Z",
    } as Parameters<typeof agentWorkVisualStatus>[0]),
    "failed",
  );
});
