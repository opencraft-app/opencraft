import React, { useState } from "react";
import type { AsyncQuestion } from "@opencraft/chat-core";
import type { AsyncQuestionDraft } from "../../apps/workbench-web/src/components/conversation-renderers/render-contexts";
import { AsyncQuestionContext } from "../../apps/workbench-web/src/components/conversation-renderers/render-contexts";
import { AsyncQuestionCard } from "../../apps/workbench-web/src/components/conversation/async-question-card";
import { WebChatDocument } from "@opencraft/chat-render-web";
import { createIntlTestRoot as createRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";

const question: AsyncQuestion = {
  id: "markdown-question",
  title: "Source MR [!4869](https://git.example.test/merge/4869) requires review. [Unsafe](javascript:alert(1))",
  options: [],
};

const probe = window as typeof window & {
  opens: string[];
  answers: string[];
};
probe.opens = [];
probe.answers = [];

function Demo() {
  const [drafts, setDrafts] = useState<Record<string, AsyncQuestionDraft>>({});
  return (
    <main style={{ padding: 24, width: "min(100%, 420px)" }}>
      <AsyncQuestionContext.Provider value={{
        states: new Map([[question.id, "pending"]]),
        queuedIds: new Set(),
        submittingIds: new Set(),
        drafts,
        errors: {},
        answer: async (_, answer) => { probe.answers.push(answer); },
        updateDraft: (id, draft) => setDrafts((current) => ({ ...current, [id]: draft })),
      }}>
        <AsyncQuestionCard
          question={question}
          title={<WebChatDocument
            conversationId="fixture-conversation"
            documentId={`async-question:${question.id}`}
            hostId="fixture-host"
            onOpenResource={(target) => probe.opens.push(target)}
            source={question.title}
          />}
        />
      </AsyncQuestionContext.Provider>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Demo />);
