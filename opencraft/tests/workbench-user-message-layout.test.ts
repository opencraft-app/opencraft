import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { UserMessageTimelineBlock } from "@opencraft/chat-core";

import { deriveUserMessageWebLayout } from "../apps/workbench-web/src/components/conversation/user-message-layout";

function message(overrides: Partial<UserMessageTimelineBlock> = {}): UserMessageTimelineBlock {
  return {
    type: "user-message",
    id: "user-message:fixture",
    sourceItemIds: [],
    message: "",
    content: [],
    attachments: [],
    messageKind: "user",
    clientId: null,
    steeringStatus: null,
    sentAtMs: null,
    deliveryStatus: null,
    referencesPriorConversation: false,
    reviewMode: false,
    pullRequestFixMode: false,
    autoResolveSync: false,
    goal: false,
    hookFeedback: false,
    commentCount: 0,
    hasExternalAttachments: false,
    ...overrides,
  };
}

test("a truly empty UserMessage retains Codex's no-content bubble", () => {
  const layout = deriveUserMessageWebLayout(message());
  assert.equal(layout.hasText, false);
  assert.equal(layout.showBubble, true);
  assert.equal(layout.showBody, true);
});

test("a user message containing only a fenced code block is not empty", () => {
  const layout = deriveUserMessageWebLayout(message({
    message: "```text\nstream=false\n```",
  }));
  assert.equal(layout.hasText, true);
  assert.equal(layout.showBubble, true);
  assert.equal(layout.showBody, true);
});

test("sending is a transport state, not a visible user-message status", () => {
  const layout = deriveUserMessageWebLayout(message({
    message: "Hello",
    deliveryStatus: "sending",
  }));
  assert.equal(layout.hasText, true);
  assert.equal(layout.hasStatus, false);
  assert.equal(layout.showBubble, true);
  assert.equal(layout.showBody, true);
  assert.equal(deriveUserMessageWebLayout(message({ message: "Hello", deliveryStatus: "failed" })).hasStatus, true);
  assert.equal(deriveUserMessageWebLayout(message({ message: "Hello", deliveryStatus: "unknown" })).hasStatus, true);
});

test("only user bubbles lift code-block size containment while code remains scrollable", () => {
  const bubbleStyles = readFileSync(new URL("../apps/workbench-web/src/styles/app.scss", import.meta.url), "utf8");
  const sharedCodeStyles = readFileSync(new URL("../packages/chat-render-web/src/renderers/code/code-block.scss", import.meta.url), "utf8");
  const bubbleStart = bubbleStyles.indexOf("  &__bubble {");
  const bubbleEnd = bubbleStyles.indexOf("  &__collapsible {", bubbleStart);
  assert.ok(bubbleStart >= 0 && bubbleEnd > bubbleStart);
  assert.match(bubbleStyles.slice(bubbleStart, bubbleEnd), /\.chat-code-block\s*\{\s*contain:\s*none;/u);
  assert.match(sharedCodeStyles, /\.chat-code-block\s*\{[^}]*contain:\s*inline-size;/u);
  assert.match(sharedCodeStyles, /\.chat-code-block__scroller\s*\{[^}]*overflow:\s*auto;/u);
});

test("attachment-only UserMessages render media without an empty bubble", () => {
  const layout = deriveUserMessageWebLayout(message({
    content: [{ type: "local-image", source: "/workspace/shot.png", detail: null }],
    hasExternalAttachments: true,
  }));
  assert.equal(layout.images.length, 1);
  assert.equal(layout.showBubble, false);
  assert.equal(layout.showBody, false);
});

test("file-only UserMessages retain a visible attachment row without manufacturing an empty bubble", () => {
  const layout = deriveUserMessageWebLayout(message({
    attachments: [{
      type: "file",
      id: "file-one",
      name: "index.ts",
      target: "/workspace/index.ts",
      mimeType: "text/typescript",
      startLine: 4,
      endLine: 8,
    }],
    hasExternalAttachments: true,
  }));
  assert.equal(layout.files.length, 1);
  assert.equal(layout.showBubble, false);
  assert.equal(layout.showBody, false);
});

test("MCP context and comments remain typed layout inputs instead of a lossy attachment boolean", () => {
  const layout = deriveUserMessageWebLayout(message({
    attachments: [
      { type: "comment", id: "comment-one", label: "index.ts", target: "/workspace/index.ts", body: "Fix this", line: 7 },
      { type: "mcp-context", id: "context-one", label: "Issue 42", target: "https://example.test/42", provider: "issues" },
    ],
    commentCount: 1,
    hasExternalAttachments: true,
  }));
  assert.equal(layout.comments.length, 1);
  assert.equal(layout.mcpContexts.length, 1);
  assert.equal(layout.hasStatus, true);
  assert.equal(layout.showBubble, false);
  assert.equal(layout.showBody, true);
});

test("prior context is an above-bubble attachment and semantic statuses can stand alone", () => {
  const prior = deriveUserMessageWebLayout(message({
    referencesPriorConversation: true,
    hasExternalAttachments: true,
  }));
  assert.equal(prior.showBubble, false);
  assert.equal(prior.showBody, false);

  const review = deriveUserMessageWebLayout(message({ reviewMode: true }));
  assert.equal(review.hasStatus, true);
  assert.equal(review.showBubble, false);
  assert.equal(review.showBody, true);
});

test("typed media and context inputs are partitioned without losing order within each surface", () => {
  const layout = deriveUserMessageWebLayout(message({
    message: "Inspect these",
    content: [
      { type: "mention", name: "src", path: "/workspace/src" },
      { type: "image", source: "https://example.test/shot.png", detail: "high" },
      { type: "skill", name: "review", path: "/skills/review/SKILL.md" },
      { type: "audio", source: "https://example.test/note.wav" },
      { type: "text", text: "Inspect these", textElements: [] },
    ],
    hasExternalAttachments: true,
  }));
  assert.deepEqual(layout.contexts.map((part) => part.type), ["mention", "skill"]);
  assert.deepEqual(layout.images.map((part) => part.type), ["image"]);
  assert.deepEqual(layout.audio.map((part) => part.type), ["audio"]);
  assert.equal(layout.showBubble, true);
  assert.equal(layout.showBody, true);
});

test("a staged file renders in the file row without a duplicate @ context chip", () => {
  const layout = deriveUserMessageWebLayout(message({
    content: [
      { type: "mention", name: "受众广.md", path: "/host/file.md" },
      { type: "mention", name: "src", path: "/workspace/src" },
    ],
    attachments: [{ type: "file", id: "/host/file.md", name: "受众广.md", target: "/host/file.md", mimeType: null, startLine: null, endLine: null }],
    hasExternalAttachments: true,
  }));
  assert.deepEqual(layout.files.map(file => file.name), ["受众广.md"]);
  assert.deepEqual(layout.contexts.map(context => context.name), ["src"]);
});
