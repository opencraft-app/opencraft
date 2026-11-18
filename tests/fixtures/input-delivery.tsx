import React, { useSyncExternalStore } from "react";
import { createConversationKey } from "@opencraft/chat-core";
import { createReplicaConversationRuntime } from "@opencraft/chat-runtime";
import type { ConversationCommandPort } from "@opencraft/chat-runtime";
import { Button } from "@opencraft/design-system-web/button";
import { createIntlTestRoot } from "./intl-root";
import { UserMessageBlock } from "../../apps/workbench-web/src/components/conversation/user-message";
import { ConversationDocumentContext } from "../../apps/workbench-web/src/components/conversation/document-context";
import { WorkbenchPresentationRootProvider } from "../../apps/workbench-web/src/components/workbench-presentation-root";
import * as themes from "@opencraft/design-system/theme-engine";
import styles from "../../apps/workbench-web/src/styles/app.scss?inline";
const root = document.getElementById("root")!;
const style = document.createElement("style");
style.textContent = styles;
document.head.append(style);
const mode =
  new URLSearchParams(location.search).get("mode") === "dark"
    ? "dark"
    : "light";
for (const [k, v] of Object.entries(
  themes.buildOpenCraftThemeCssProperties(
    mode,
    themes.opencraftNeutralThemePalette[mode],
  ),
))
  root.style.setProperty(k, v);
root.dataset.theme = mode;
root.dataset.uiDensity = new URLSearchParams(location.search).has("touch")
  ? "touch"
  : "compact";
root.style.cssText +=
  ";min-height:100vh;background:var(--color-background-surface);padding:20px;color:var(--color-text)";
const key = createConversationKey("fixture", "thread");
const snapshot = {
  revision: 1,
  storageKey: "fixture",
  scope: "thread",
  phase: "live" as const,
  authoritative: true,
  epoch: "fixture",
  nextSeq: 2,
  journalStartSeq: 1,
  entities: new Map([
    [
      "thread",
      {
        thread: { id: "thread", status: { type: "active" } },
        turns: [
          {
            id: "old-turn",
            status: "inProgress",
            startedAt: 1728000000,
            items: [
              {
                id: "primary",
                type: "userMessage",
                content: [{ type: "text", text: "Please work on this task" }],
              },
            ],
          },
        ],
      },
    ],
  ]),
  lastError: null,
};
const runtime = createReplicaConversationRuntime({
  key,
  replica: { getSnapshot: () => snapshot, subscribe: () => () => {} },
  commands: {} as ConversationCommandPort,
  history: { async loadOlder() {} },
});
const row = {
  id: "follow",
  clientUserMessageId: "follow-client",
  input: [{ type: "text" as const, text: "继续", text_elements: [] }],
  createdAt: 1728000001000,
  pausedReason: null,
  targetTurnId: "old-turn",
};
const receipt = {
  version: 1 as const,
  custody: "accepted" as const,
  nativeAdmission: "accepted" as const,
  context: "unobserved" as const,
  targetTurnId: "old-turn",
  execution: "running" as const,
  revision: 2,
};
runtime.replaceQueuedSubmissions([], [{ ...row, delivery: receipt }]);
function App() {
  const state = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );
  return (
    <WorkbenchPresentationRootProvider target={root}>
      <ConversationDocumentContext.Provider
        value={{
          hostId: "fixture",
          conversationId: "thread",
          cwd: null,
          theme: mode,
        }}
      >
        <main
          style={{ maxWidth: 780, margin: "auto" }}
          data-active={state.activeTurn?.turnId ?? "none"}
        >
          {state.timeline.frames
            .flatMap((f) => f.blocks)
            .filter((b) => b.type === "user-message")
            .map((b) => (
              <UserMessageBlock
                key={b.id}
                block={b as Extract<typeof b, { type: "user-message" }>}
              />
            ))}
          <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
            <Button
              onClick={() =>
                runtime.replaceQueuedSubmissions(
                  [],
                  [
                    {
                      ...row,
                      delivery: {
                        ...receipt,
                        execution: "interrupted",
                        revision: 3,
                      },
                    },
                  ],
                )
              }
            >
              Stop turn
            </Button>
            <Button
              onClick={() =>
                runtime.replaceQueuedSubmissions(
                  [],
                  [{ ...row, delivery: receipt }],
                )
              }
            >
              Deliver late reply
            </Button>
          </div>
          <textarea
            aria-label="Draft"
            placeholder="Draft"
            style={{ marginTop: 20, width: "100%", minHeight: 80 }}
          />
        </main>
      </ConversationDocumentContext.Provider>
    </WorkbenchPresentationRootProvider>
  );
}
createIntlTestRoot(root, undefined, "zh-CN").render(<App />);
