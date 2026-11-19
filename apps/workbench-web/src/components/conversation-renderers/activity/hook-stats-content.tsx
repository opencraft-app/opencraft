import { Fragment } from "react";
import { formatHookEventName, formatHookSource, type HookStats } from "@opencraft/chat-core";

function hookStatsEntryLabel(kind: HookStats["entries"][number]["kind"]): string {
  switch (kind) {
    case "feedback":
      return "Feedback";
    case "stop":
      return "Stop";
    case "error":
      return "Error";
  }
}

function HookStatsSummary({ stats }: { readonly stats: HookStats }) {
  return (
    <>
      <strong>Hooks summary</strong>
      <span className="thread-hook-stats__counts">
        <span>Ran</span>
        <b>{stats.count}</b>
        {stats.blockedCount > 0 ? (
          <>
            <span>Blocked</span>
            <b>{stats.blockedCount}</b>
          </>
        ) : null}
        {stats.errorCount > 0 ? (
          <>
            <span>Errors</span>
            <b>{stats.errorCount}</b>
          </>
        ) : null}
      </span>
      {stats.entries.length > 0 ? (
        <span className="thread-hook-stats__entries">
          {stats.entries.map((entry, index) => (
            <span className="thread-hook-stats__entry" key={`${entry.kind}:${index}:${entry.text}`}>
              <em>{hookStatsEntryLabel(entry.kind)}</em>
              <span>{entry.text}</span>
            </span>
          ))}
        </span>
      ) : null}
    </>
  );
}

function HookStatsDetails({ stats }: { readonly stats: HookStats }) {
  return (
    <>
      <strong>Hooks</strong>
      <ul className="thread-hook-stats__runs">
        {stats.runs.map((run) => (
          <Fragment key={run.id}>
            <li>{formatHookEventName(run.eventName)}</li>
            <li className="thread-hook-stats__run">
              <span>
                {formatHookSource(run.source)}
                {run.count > 1 ? ` · ${String(run.count)} runs` : ""}
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
