import { type ReactNode } from "react";
import { useIntl } from "@opencraft/i18n/react";
import type { ConversationRecoveryPresentation } from "@opencraft/chat-core";
import "./history-presentation.scss";

/** Display provenance never grants mutation authority. Keep nodes and geometry. */
export function historyPresentationAttributes(presentation: ConversationRecoveryPresentation) {
  return {
    "data-history-presentation": presentation,
    "aria-busy": presentation.endsWith("-loading") || undefined,
  } as const;
}
export function ConversationHistoryStatus({
  presentation,
  children,
}: {
  presentation: ConversationRecoveryPresentation;
  children?: ReactNode;
}) {
  const intl = useIntl();
  return (
    <div
      className="conversation-history-status"
      data-pending={presentation.endsWith("-loading") || undefined}
      role="status"
      aria-live="polite"
      aria-label={
        presentation.endsWith("-loading")
          ? intl.formatMessage({ id: "chat.restore.loading", defaultMessage: "Loading conversation history…" })
          : undefined
      }
    >
      {presentation.endsWith("-loading") ? null : children}
    </div>
  );
}
