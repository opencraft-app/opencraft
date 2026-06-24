import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("turn meta renderer owns a leaf timer instead of relying on stream events", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/blocks/TurnMetaRenderer.tsx"),
    "utf8",
  );

  assert.match(source, /function TurnElapsedLabel/);
  assert.match(source, /setInterval\([^,]+,\s*1000\)/);
  assert.doesNotMatch(source, /buildChatRenderModel|toWebChatModel|refreshScheduler/);
});

test("turn meta running timer keeps its text in component state across parent renders", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/blocks/TurnMetaRenderer.tsx"),
    "utf8",
  );

  assert.match(source, /useState/);
  assert.match(source, /setLabel\(runningTurnLabel\(block\.createdAt\)\)/);
  assert.doesNotMatch(source, /const initialText = turnElapsedLabel\(block\)/);
  assert.doesNotMatch(source, /<span ref=\{textRef\}>\{initialText\}<\/span>/);
});

test("turn meta renderer is only a timing boundary, not an agent work container", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/blocks/TurnMetaRenderer.tsx"),
    "utf8",
  );

  assert.doesNotMatch(source, /block\.work/);
  assert.doesNotMatch(source, /ActivityRenderer/);
  assert.doesNotMatch(source, /<details/);
  assert.doesNotMatch(source, /<summary/);
  assert.doesNotMatch(source, /turnHeaderChevron/);
});

test("turn meta divider is laid out below the label", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/styles/desktop.module.css"),
    "utf8",
  );
  const turnHeader =
    source.match(/\.turnHeader\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  const turnLine =
    source.match(/\.turnHeaderLine\s*\{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(turnHeader, /display:\s*grid/);
  assert.doesNotMatch(turnHeader, /display:\s*flex/);
  assert.match(turnLine, /width:\s*100%/);
  assert.doesNotMatch(turnLine, /flex:\s*1/);
});
