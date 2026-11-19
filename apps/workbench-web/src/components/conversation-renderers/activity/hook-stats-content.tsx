import { Fragment } from "react";
import { formatHookEventName, formatHookSource, type HookStats } from "@opencraft/chat-core";
import type { IntlShape } from "@opencraft/i18n";
import { useIntl } from "@opencraft/i18n/react";

function hookStatsEntryLabel(intl: IntlShape, kind: HookStats["entries"][number]["kind"]): string {
  switch (kind) {
    case "feedback":
      return intl.formatMessage({ id: "chat.hookStats.entry.feedback", defaultMessage: "Feedback" });
    case "stop":
      return intl.formatMessage({ id: "chat.hookStats.entry.stop", defaultMessage: "Stop" });
    case "error":
      return intl.formatMessage({ id: "chat.hookStats.entry.error", defaultMessage: "Error" });
  }
}

function HookStatsSummary({ stats }: { readonly stats: HookStats }) {
  const intl = useIntl();
  return (
    <>
      <strong>{intl.formatMessage({ id: "chat.hookStats.summary", defaultMessage: "Hooks summary" })}</strong>
      <span className="thread-hook-stats__counts">
        <span>{intl.formatMessage({ id: "chat.hookStats.ran", defaultMessage: "Ran" })}</span>
        <b>{stats.count}</b>
        {stats.blockedCount > 0 ? (
          <>
            <span>{intl.formatMessage({ id: "chat.hookStats.blocked", defaultMessage: "Blocked" })}</span>
            <b>{stats.blockedCount}</b>
          </>
        ) : null}
        {stats.errorCount > 0 ? (
          <>
            <span>{intl.formatMessage({ id: "chat.hookStats.errors", defaultMessage: "Errors" })}</span>
            <b>{stats.errorCount}</b>
          </>
        ) : null}
      </span>
      {stats.entries.length > 0 ? (
        <span className="thread-hook-stats__entries">
          {stats.entries.map((entry, index) => (
            <span className="thread-hook-stats__entry" key={`${entry.kind}:${index}:${entry.text}`}>
              <em>{hookStatsEntryLabel(intl, entry.kind)}</em>
              <span>{entry.text}</span>
            </span>
          ))}
        </span>
      ) : null}
    </>
  );
}

function HookStatsDetails({ stats }: { readonly stats: HookStats }) {
  const intl = useIntl();
  return (
    <>
      <strong>{intl.formatMessage({ id: "chat.hookStats.title", defaultMessage: "Hooks" })}</strong>
      <ul className="thread-hook-stats__runs">
        {stats.runs.map((run) => (
          <Fragment key={run.id}>
            <li>{formatHookEventName(run.eventName)}</li>
            <li className="thread-hook-stats__run">
              <span>
                {formatHookSource(run.source)}
                {run.count > 1
                  ? intl.formatMessage({ id: "chat.hookStats.runs", defaultMessage: " · {count} runs" }, { count: String(run.count) })
                  : ""}
              </span>
              {run.statusMessage === null ? null : <span>{run.statusMessage}</span>}
              {run.entries.map((entry, index) => (
                <span className={`is-${entry.tone}`} key={`${entry.tone}:${index}:${entry.text}`}>
                  {entry.text}
                </span>
              ))}
            </li>
          </Fragment>
        ))}
      </ul>
    </>
  );
}

export default function HookStatsContent({
  stats,
  detailed,
}: {
  readonly stats: HookStats;
  readonly detailed: boolean;
}) {
  return detailed ? <HookStatsDetails stats={stats} /> : <HookStatsSummary stats={stats} />;
}
