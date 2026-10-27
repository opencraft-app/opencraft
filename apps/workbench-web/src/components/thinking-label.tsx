import React from "react";
import { FormattedMessage } from "@opencraft/i18n/react";

/** Localize the status placeholder, preserving actual reasoning summaries. */
export function ThinkingLabel({ summary }: { readonly summary?: string }) {
  return summary && summary !== "Thinking"
    ? <React.Fragment>{summary}</React.Fragment>
    : <FormattedMessage id="chat.thinking" defaultMessage="Thinking" />;
}
