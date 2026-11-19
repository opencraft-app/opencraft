import React from "react";
import { ComposerQueueTray } from "../../packages/composer-editor/src/queue-tray";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";
createIntlTestRoot(document.getElementById("root")!).render(
  <>
    <textarea aria-label="Draft" defaultValue="keep draft" />
    <ComposerQueueTray
      isResponseInProgress
      items={[
        {
          id: "fixture",
          preview: "1. **Invite members**\n2. Read [docs](https://example.com/private-path) and `a_b`",
          state: "queued",
          operation: "idle",
          actionable: true,
          editing: false,
        },
      ]}
    />
  </>,
);
