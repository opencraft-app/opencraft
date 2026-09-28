import type { TimelineSourceTurn } from "@opencraft/chat-core";

import type { WorkbenchFileChange, WorkbenchThread } from "./models";

export const demoThreads: readonly WorkbenchThread[] = [
  { id: "codex-frame", title: "Restore the desktop frame", project: "OpenCraft", lineage: "root", time: "Now", updatedAt: 1_725_724_800, status: "running" },
  { id: "replica", title: "Implement Replica synchronization", project: "OpenCraft", lineage: "root", time: "12m", updatedAt: 1_725_724_080, status: "review", unread: true },
  { id: "composer", title: "Port the ProseMirror composer", project: "OpenCraft", lineage: "root", time: "Yesterday", updatedAt: 1_725_638_400, status: "ready" },
  { id: "multi-host", title: "Model the multi-host transport", project: "Daemon", lineage: "root", time: "Tue", updatedAt: 1_725_379_200, status: "ready" },
];

export const demoChangedFiles: readonly WorkbenchFileChange[] = [
  { path: "apps/workbench-web/src/components/app-shell.tsx", additions: 128, deletions: 0, status: "added" },
  { path: "packages/codex-composer/src/codex-composer.tsx", additions: 482, deletions: 0, status: "added" },
  { path: "packages/design-system/src/theme-engine.ts", additions: 328, deletions: 0, status: "added" },
  { path: "apps/workbench-web/src/styles/app.scss", additions: 846, deletions: 1174, status: "modified" },
];

export const demoInitialTurns: readonly TimelineSourceTurn[] = [
  {
    id: "turn-source-restore",
    status: "complete",
    items: [
      {
        id: "item-user-source",
        type: "userMessage",
        payload: {
          id: "item-user-source",
          type: "userMessage",
          text: "严格按照最新恢复源码重写 Frame、主题和 Composer，不保留旧仿制实现。",
        },
      },
      {
        type: "reasoning",
        id: "item-reasoning-source",
        payload: {
          id: "item-reasoning-source",
          type: "reasoning",
          summary: "Read the latest AppShell, theme engine, and composer ownership boundaries",
          detail: "The main surface owns the transparent header, thread viewport, right panel, and composer. The left panel remains a sibling under the fixed application header.",
          status: "completed",
        },
      },
      {
        id: "item-assistant-source",
        type: "agentMessage",
        payload: {
          id: "item-assistant-source",
          type: "agentMessage",
          text: "The application now follows a single-owner workbench model. There is one elevated main surface, the task-details panel is nested inside it, and the input is a ProseMirror editor with commands, mentions, skills, attachments, paste, drop, IME-safe input, history, send, and stop behavior.",
          completed: true,
          status: "completed",
        },
      },
      {
        id: "item-patch-source",
        type: "fileChange",
        payload: {
          id: "item-patch-source",
          type: "fileChange",
          callId: "patch-source-restore",
          title: "Rebuilt as maintainable TypeScript source",
          changes: demoChangedFiles.map((change) => ({
            path: change.path,
            status: change.status,
            additions: change.additions,
            deletions: change.deletions,
          })),
          status: "completed",
        },
      },
    ],
  },
];

export const deterministicDemoReply = "The request is now attached to the same typed session. The source-owned shell stays stable while the view projection streams this deterministic response. You can stop it, retry from the transcript, or add files and structured context in the composer.";
