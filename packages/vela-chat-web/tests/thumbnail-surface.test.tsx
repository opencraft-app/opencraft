import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ChatRenderModel } from "../../vela-chat-render-model/src";

register(new URL("./css-module-loader.mjs", import.meta.url));

const root = process.cwd();

test("conversation preview renders the shared conversation DOM scaled", async () => {
  const { ConversationPreviewSurface } = await import("../src/thumbnail");
  const html = renderToStaticMarkup(
    <ConversationPreviewSurface
      model={previewModel()}
      canvasWidth={840}
      canvasHeight={520}
      scale={0.5}
    />,
  );

  assert.match(html, /data-conversation-preview="true"/);
  assert.match(html, /data-layout="contained"/);
  assert.match(html, /class="composerDock"/);
  assert.match(html, /placeholder="要求后续变更"/);
  assert.match(html, /data-conversation-strategy="web-plain"/);
  assert.match(html, /data-turn-kind="user_message"/);
  assert.match(html, /data-turn-kind="agent_work"/);
  assert.match(html, /Build the app/);
  assert.match(html, /Running command/);
  assert.match(html, /Checking[\s\S]*failures/);
  assert.match(html, /width:420px/);
  assert.match(html, /height:260px/);
  assert.match(html, /transform:scale\(0\.5\)/);
  assert.doesNotMatch(html, /Left panel activity/);
  assert.doesNotMatch(html, /RUNNING|COMPLETED|FAILED|WAITING/);
});

test("conversation preview reuses ChatSurface without Electron or custom turn rendering", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/thumbnail/ConversationPreviewSurface.tsx"),
    "utf8",
  );
  const readme = readFileSync(
    join(root, "packages/vela-chat-web/src/thumbnail/README.md"),
    "utf8",
  );

  assert.match(source, /ChatSurface/);
  assert.doesNotMatch(source, /VelaTurnList/);
  assert.doesNotMatch(source, /toWebChatModel/);
  assert.doesNotMatch(source, /electron|ipcRenderer|BrowserWindow/);
  assert.match(readme, /directly renders the shared `ChatSurface`/);
  assert.match(readme, /must not import Electron/);
  assert.match(readme, /must not rebuild turn rows/);
});

test("preview shell keeps the work-monitor edge compact without custom message CSS", () => {
  const css = readFileSync(
    join(root, "packages/vela-chat-web/src/thumbnail/thumbnail.module.css"),
    "utf8",
  );

  assert.match(css, /\.conversationPreviewFrame\s*\{[^}]*border-radius:\s*14px;/s);
  assert.match(css, /\.conversationPreviewFrame\s*\{[^}]*0 1px 2px rgb\(15 23 42 \/ 18%\)/s);
  assert.doesNotMatch(css, /\.messageRow|\.toolRow|\.statusRow|\.requestRow/);
  assert.doesNotMatch(css, /\.conversationPreviewFrame\s*\{[^}]*0 28px 90px/s);
  assert.doesNotMatch(css, /\.conversationPreviewFrame\s*\{[^}]*border-radius:\s*24px;/s);
});

function previewModel(): ChatRenderModel {
  return {
    session_id: "sess_preview",
    host: { kind: "desktop_shell" },
    requests: { items: [] },
    composer: {
      placeholder: "要求后续变更",
      can_send: true,
      is_running: true,
    },
    rows: [
      {
        kind: "user_message",
        id: "u1",
        key: "message:u1",
        text: "Build the app",
        copy_text: "Build the app",
        collapsed: false,
        parts: [{ id: "u1:text", type: "text", text: "Build the app" }],
        createdAt: "2026-06-18T10:00:00Z",
        debug: debug("u1"),
      },
      {
        kind: "agent_work",
        id: "tool_1",
        key: "tool:tool_1",
        title: "Running command",
        summary: "npm test",
        status: "running",
        display: "compact",
        createdAt: "2026-06-18T10:00:01Z",
        agentWorkId: "tool_1",
        debug: debug("tool_1"),
      },
      {
        kind: "assistant_message",
        id: "a1",
        key: "message:a1",
        blocks: [{ id: "a1:block:0", text: "Checking failures\n\nReading diagnostics" }],
        status: "streaming",
        streaming: true,
        revision: 1,
        createdAt: "2026-06-18T10:00:02Z",
        debug: debug("a1"),
      },
    ],
  };
}

function debug(id: string) {
  return {
    projection: "conversation" as const,
    source_event_ids: [`evt_${id}`],
    source_event_ranges: [],
  };
}
