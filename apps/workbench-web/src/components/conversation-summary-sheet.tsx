import type { ReactNode } from "react";
import { ModalSurface } from "./modal/modal-surface";
import { AdaptiveSheetHandle } from "./modal/adaptive-sheet-handle";

export default function ConversationSummarySheet({ children, label, closeLabel, onDismiss, returnFocus }: {
  readonly children: ReactNode;
  readonly label: string;
  readonly closeLabel: string;
  readonly onDismiss: () => void;
  readonly returnFocus: () => HTMLElement | null;
}) {
  return <ModalSurface label={label} className="conversation-summary-sheet" appearance="utility" presentation="adaptive-sheet" size="compact"
    closeLabel={closeLabel} onDismiss={onDismiss} returnFocus={returnFocus}>
    <AdaptiveSheetHandle onDismiss={onDismiss} />
    <div id="conversation-task-summary" className="conversation-summary__sheet-content">{children}</div>
  </ModalSurface>;
}
