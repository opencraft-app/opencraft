import { useEffect, useRef, useState } from "react";
import type { ChannelGroupSyncStatus } from "@opencraft/appserver-protocol";
import { Button } from "@opencraft/design-system-web/button";
import { useIntl } from "@opencraft/i18n/react";
import type { ChannelsClient } from "./channel-client";

const labels = {
  checked: { id: "im.channels.group.sync.checked", defaultMessage: "Check complete" },
  lastCheck: { id: "im.channels.group.sync.lastCheck", defaultMessage: "Checked {time}" },
  details: { id: "im.channels.group.sync.details", defaultMessage: "Connection details" },
  never: { id: "im.channels.group.sync.never", defaultMessage: "Not checked yet" },
  idle: { id: "im.channels.group.sync.idle", defaultMessage: "Up to date" },
  pending: { id: "im.channels.group.sync.pending", defaultMessage: "Sync queued" },
  syncing: { id: "im.channels.group.sync.syncing", defaultMessage: "Syncing…" },
  error: { id: "im.channels.group.sync.error", defaultMessage: "Sync failed. Try again." },
  paused: { id: "im.channels.group.sync.paused", defaultMessage: "Sync paused" },
  disconnected: { id: "im.channels.group.sync.disconnected", defaultMessage: "External group disconnected" },
  off: { id: "im.channels.group.sync.off", defaultMessage: "Not synced" },
  observe: { id: "im.channels.group.sync.observe", defaultMessage: "Check for changes only" },
  inbound: { id: "im.channels.group.sync.inbound", defaultMessage: "Receive changes from WeCom" },
  both: { id: "im.channels.group.sync.both", defaultMessage: "Two-way" },
  noSuccess: { id: "im.channels.group.sync.noSuccess", defaultMessage: "Never synced successfully" },
  title: { id: "im.channels.group.sync.title", defaultMessage: "WeCom connection" },
  directions: { id: "im.channels.group.sync.directions", defaultMessage: "Group name: {name}; members: {members}" },
  lastSuccess: { id: "im.channels.group.sync.lastSuccess", defaultMessage: "Updated {time}" },
  requestFailed: { id: "im.channels.group.sync.requestFailed", defaultMessage: "Could not check. Try again." },
  policy: {
    id: "im.channels.group.sync.policy",
    defaultMessage:
      "Uses the configured sync directions. Without configuration, checks only; never grants history access or imports members.",
  },
  refresh: { id: "im.channels.group.sync.refresh", defaultMessage: "Check now" },
  ownerOnly: {
    id: "im.channels.group.sync.ownerOnly",
    defaultMessage: "Only the linked group owner can sync an active external group.",
  },
  loadFailed: { id: "im.channels.group.sync.loadFailed", defaultMessage: "Could not load sync status." },
  retry: { id: "im.channels.group.sync.retry", defaultMessage: "Retry" },
  deliveryAttention: { id: "im.channels.group.sync.deliveryAttention", defaultMessage: "Some changes have not synced" },
  deliveryFailed: { id: "im.channels.group.sync.deliveryFailed", defaultMessage: "{action} not synced to WeCom." },
  rename: { id: "im.channels.group.sync.actionRename", defaultMessage: "Rename group" },
  add: { id: "im.channels.group.sync.actionAdd", defaultMessage: "Add member" },
  remove: { id: "im.channels.group.sync.actionRemove", defaultMessage: "Remove member" },
  ownerRequired: {
    id: "im.channels.group.sync.ownerRequired",
    defaultMessage: "WeCom requires group owner privileges for this action. Ask the WeCom group owner to handle it.",
  },
  deliveryConflict: {
    id: "im.channels.group.sync.deliveryConflict",
    defaultMessage: "The external value changed. Review the group before submitting another change.",
  },
  deliveryRejected: {
    id: "im.channels.group.sync.deliveryRejected",
    defaultMessage: "WeCom did not complete this change. Check the external group and its permissions.",
  },
  localApplied: {
    id: "im.channels.group.sync.localApplied",
    defaultMessage: "The OpenCraft change has taken effect. Checking does not resend failed changes.",
  },
  removalOnly: {
    id: "im.channels.group.sync.removalOnly",
    defaultMessage: "Adding members and renaming are checked independently.",
  },
} as const;
const states = {
  never: labels.never,
  idle: labels.idle,
  pending: labels.pending,
  syncing: labels.syncing,
  error: labels.error,
  paused: labels.paused,
  disconnected: labels.disconnected,
};
const directions = {
  off: labels.off,
  observe: labels.observe,
  inbound: labels.inbound,
  both: labels.both,
};

export function GroupSyncSection({
  status,
  busy = false,
  error = false,
  readFailed = false,
  onRefresh,
}: {
  status: ChannelGroupSyncStatus;
  busy?: boolean;
  error?: boolean;
  readFailed?: boolean;
  onRefresh: () => void;
}) {
  const intl = useIntl();
  const checksOnly =
    !status.configured ||
    ![status.name, status.members].some((direction) => direction === "inbound" || direction === "both");
  const running = busy || (!readFailed && (status.state === "pending" || status.state === "syncing"));
  const issue = status.deliveryIssue;
  const last =
    status.lastSyncedAt === null
      ? intl.formatMessage(labels.noSuccess)
      : intl.formatDate(status.lastSyncedAt, { year: "numeric", month: "2-digit", day: "2-digit" }) +
        " " +
        intl.formatTime(status.lastSyncedAt, { hour: "2-digit", minute: "2-digit" });
  return (
    <section className="im-channel-group-sync" aria-label={intl.formatMessage(labels.title)} aria-busy={running}>
      <div className="im-channel-group-dialog__section-heading">
        <h3>{intl.formatMessage(labels.title)}</h3>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={running || (!status.canRefresh && !readFailed)}
          loading={running}
          onClick={onRefresh}
        >
          {intl.formatMessage(error || (status.state === "error" && !issue) ? labels.retry : labels.refresh)}
        </Button>
      </div>
      <p
        className="im-channel-group-sync__status"
        role="status"
        aria-live="polite"
        data-state={error ? "error" : status.state}
      >
        <span aria-hidden="true" />
        {intl.formatMessage(
          error
            ? labels.requestFailed
            : status.state === "error" && issue
              ? labels.deliveryAttention
              : status.state === "idle" && checksOnly
                ? labels.checked
                : states[status.state],
        )}
      </p>
      {issue && (
        <div className="im-channel-group-sync__delivery-issue" role="status" aria-live="polite">
          <p>
            {intl.formatMessage(labels.deliveryFailed, { action: intl.formatMessage(labels[issue.action]) })}{" "}
            {intl.formatMessage(
              issue.reason === "owner_required"
                ? labels.ownerRequired
                : issue.reason === "conflict"
                  ? labels.deliveryConflict
                  : labels.deliveryRejected,
            )}
          </p>
          <p>
            {intl.formatMessage(labels.localApplied)}{" "}
            {issue.action === "remove" && issue.reason === "owner_required" && intl.formatMessage(labels.removalOnly)}
          </p>
        </div>
      )}
      <p className="im-channel-group-sync__updated">
        {status.lastSyncedAt === null
          ? intl.formatMessage(labels.never)
          : intl.formatMessage(checksOnly || issue ? labels.lastCheck : labels.lastSuccess, { time: last })}
      </p>
      <details>
        <summary>{intl.formatMessage(labels.details)}</summary>
        <p>
          {intl.formatMessage(labels.directions, {
            name: intl.formatMessage(directions[status.name]),
            members: intl.formatMessage(directions[status.members]),
          })}
        </p>
        <p>{intl.formatMessage(labels.policy)}</p>
        {status.mentionIngress === "text-only" && (
          <p>
            {intl.formatMessage({
              id: "im.channels.externalMentionIngress",
              defaultMessage: "External mentions arrive as text; this source does not provide member target IDs.",
            })}
          </p>
        )}
        {!status.canRefresh && <p>{intl.formatMessage(labels.ownerOnly)}</p>}
      </details>
    </section>
  );
}

/** Dialog-scoped lifetime. Notifications are hints; bounded read-only polling recovers lost hints. */
export function useGroupSync(client: ChannelsClient, channelId: string) {
  const [status, setStatus] = useState<ChannelGroupSyncStatus | null>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [requestFailed, setRequestFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const request = useRef<AbortController | null>(null);
  const attempt = useRef<{ key: string; baseline: number | null } | null>(null);
  useEffect(() => {
    const owner = new AbortController();
    let reading = false,
      supported = true;
    const read = async (signal: AbortSignal) => {
      if (reading) return;
      reading = true;
      try {
        const next = await client.groupSyncStatus(channelId, signal);
        if (!signal.aborted && !owner.signal.aborted) {
          supported = next !== null;
          setStatus(next);
          setLoadFailed(false);
          // Positive background progress recovers an ACK lost after admission.
          if (
            next &&
            attempt.current &&
            !request.current &&
            (next.state === "pending" || next.state === "syncing" || next.lastAttemptAt !== attempt.current.baseline)
          ) {
            attempt.current = null;
            setRequestFailed(false);
          }
        }
      } catch (error) {
        if (!signal.aborted && !owner.signal.aborted) {
          if (error instanceof Error && error.message === "method_not_found") {
            supported = false;
            setStatus(null);
          } else setLoadFailed(true);
        }
      } finally {
        reading = false;
      }
    };
    client.watch(
      channelId,
      read,
      () => {
        if (!owner.signal.aborted) setLoadFailed(true);
      },
      owner.signal,
    );
    const timer = setInterval(() => {
      if (supported && (typeof document === "undefined" || document.visibilityState !== "hidden"))
        void read(owner.signal);
    }, 5000);
    return () => {
      owner.abort();
      clearInterval(timer);
      request.current?.abort();
    };
  }, [client, channelId, retry]);
  async function refresh() {
    if (request.current || !status?.canRefresh) return;
    if (attempt.current && status.lastAttemptAt !== attempt.current.baseline) attempt.current = null;
    const owner = new AbortController();
    request.current = owner;
    attempt.current ??= { key: crypto.randomUUID(), baseline: status.lastAttemptAt };
    setBusy(true);
    setRequestFailed(false);
    try {
      const next = await client.refreshGroupSync(channelId, attempt.current.key, owner.signal);
      if (!owner.signal.aborted) {
        setStatus(next);
        attempt.current = null;
      }
    } catch {
      if (!owner.signal.aborted) setRequestFailed(true);
    } finally {
      if (!owner.signal.aborted) setBusy(false);
      request.current = null;
    }
  }
  return { status, loadFailed, requestFailed, busy, retry: () => setRetry((value) => value + 1), refresh };
}

export type GroupSyncState = ReturnType<typeof useGroupSync>;

/** One-line summary for the group-info navigation row. */
export function groupSyncSummary(intl: ReturnType<typeof useIntl>, sync: GroupSyncState): string | null {
  if (sync.status === null) return null;
  if (sync.status === undefined) return sync.loadFailed ? intl.formatMessage(labels.loadFailed) : "";
  const checksOnly =
    !sync.status.configured ||
    ![sync.status.name, sync.status.members].some((direction) => direction === "inbound" || direction === "both");
  const state = intl.formatMessage(
    sync.status.state === "error" && sync.status.deliveryIssue
      ? labels.deliveryAttention
      : sync.status.state === "idle" && checksOnly
        ? labels.checked
        : states[sync.status.state],
  );
  return sync.status.lastSyncedAt === null
    ? state
    : state + " · " + intl.formatTime(sync.status.lastSyncedAt, { hour: "2-digit", minute: "2-digit" });
}

export function GroupSyncPanel({ sync }: { sync: GroupSyncState }) {
  const intl = useIntl();
  const { status, loadFailed, requestFailed, busy } = sync;
  if (status === null) return null;
  if (status === undefined)
    return loadFailed ? (
      <div role="status">
        {intl.formatMessage(labels.loadFailed)}
        <Button type="button" variant="ghost" onClick={sync.retry}>
          {intl.formatMessage(labels.retry)}
        </Button>
      </div>
    ) : null;
  return (
    <GroupSyncSection
      status={status}
      busy={busy}
      error={requestFailed || loadFailed}
      readFailed={loadFailed}
      onRefresh={() => {
        if (loadFailed) sync.retry();
        else void sync.refresh();
      }}
    />
  );
}
