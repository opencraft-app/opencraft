import React, { useState } from "react";
import { buildOpenCraftThemeCssProperties } from "@opencraft/design-system/theme-engine";
import type { ChatResourceDecision, ChatResourceOpenIntent } from "@opencraft/chat-render-web";
import { WebChatDocument } from "@opencraft/chat-render-web";

import { createIntlTestRoot as createRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";

document.documentElement.dataset.theme = "light";
for (const [key, value] of Object.entries(buildOpenCraftThemeCssProperties("light"))) {
  document.documentElement.style.setProperty(key, value);
}

const probe = window as typeof window & {
  opens: Array<{ target: string; decision: ChatResourceDecision; intent?: ChatResourceOpenIntent }>;
  setStreaming(value: boolean): void;
  setUrl(value: string): void;
};
probe.opens = [];

function Demo() {
  const [streaming, setStreaming] = useState(false);
  const [url, setUrl] = useState("https://git.example.test/merge/4438?oai_link_source=model_response_hotline");
  probe.setStreaming = setStreaming;
  probe.setUrl = setUrl;
  return (
    <main style={{ padding: 40, width: 760 }}>
      <WebChatDocument
        documentId="url-presentation"
        onOpenResource={(target, decision, intent) => probe.opens.push({ target, decision, intent })}
        source={`## [!4438 · chore(nextgen-dashboard): decommission client and deploy-facing GitOps](${url})`}
        streaming={streaming}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Demo />);
