import React from "react";
import { useIntl } from "@opencraft/i18n/react";

/** Both message roles use the application locale and the viewer's local day. */
export function MessageTimestamp({ sentAtMs, assistant = false }: {
  readonly sentAtMs: number | null | undefined;
  readonly assistant?: boolean;
}) {
  const intl = useIntl();
  if (sentAtMs == null) return null;
  const sent = new Date(sentAtMs);
  if (!Number.isFinite(sent.getTime())) return null;
  const now = new Date();
  // Compare calendar days rather than elapsed hours, including across DST.
  const dayOffset = (Date.UTC(sent.getFullYear(), sent.getMonth(), sent.getDate())
    - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const options: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timeZone === "Etc/Unknown" ? undefined : timeZone,
  };
  if (dayOffset < 0 && dayOffset > -7) options.weekday = "long";
  else if (dayOffset !== 0) {
    options.month = "short";
    options.day = "numeric";
  }
  return <time
    data-assistant-message-sent-time={assistant ? "" : undefined}
    dateTime={sent.toISOString()}
    title={intl.formatDate(sent, { ...options, year: "numeric", month: "long", day: "numeric", weekday: "long", second: "2-digit", timeZoneName: "short" })}
  >{intl.formatDate(sent, options)}</time>;
}
