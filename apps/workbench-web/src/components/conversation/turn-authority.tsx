import { useContext, useMemo, type ReactNode } from "react";
import { ConversationDocumentContext } from "./document-context";
import { VisibleTurnReceiptContext } from "./visible-turn-receipt";
import { AsyncQuestionContext, ConversationInteractionContext } from "../conversation-renderers/render-contexts";

/** Cached prefix rows coexist with a live tail, but cannot inherit its actions.
 * Keep the same provider tree when authority arrives so the row stays mounted. */
export function ConversationTurnAuthority({ readOnly, children }: {
  readonly readOnly: boolean;
  readonly children: ReactNode;
}) {
  const document = useContext(ConversationDocumentContext);
  const questions = useContext(AsyncQuestionContext);
  const interaction = useContext(ConversationInteractionContext);
  const receipt = useContext(VisibleTurnReceiptContext);
  const documentValue = useMemo(() => readOnly ? { ...document,
    turnActions: { ...document.turnActions,
      fork: document.turnActions?.fork ?? document.onForkTurn !== undefined,
      reviewDiff: document.turnActions?.reviewDiff ?? document.onReviewTurnDiff !== undefined },
    onForkTurn: undefined, onReviewTurnDiff: undefined, renderAssistantActions: undefined,
  } : document, [document, readOnly]);
  const questionValue = useMemo(() => readOnly ? { ...questions, answer: null } : questions, [questions, readOnly]);
  const interactionValue = useMemo(() => readOnly ? { ...interaction, canRespond: false, respond: null } : interaction, [interaction, readOnly]);
  return <ConversationDocumentContext.Provider value={documentValue}>
    <AsyncQuestionContext.Provider value={questionValue}>
      <ConversationInteractionContext.Provider value={interactionValue}>
        <VisibleTurnReceiptContext.Provider value={readOnly ? undefined : receipt}>
          {children}
        </VisibleTurnReceiptContext.Provider>
      </ConversationInteractionContext.Provider>
    </AsyncQuestionContext.Provider>
  </ConversationDocumentContext.Provider>;
}
