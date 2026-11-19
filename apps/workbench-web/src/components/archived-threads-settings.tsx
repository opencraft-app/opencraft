import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useIntl } from "@opencraft/i18n/react";
import { SettingsActions, SettingsButton, SettingsGroup, SettingsListItem, SettingsNotice, SettingsPageHeader } from "@opencraft/extension-react";
import { archivedConversationLabel } from "../sidebar-activity";
import { useAsyncNotices } from "./async-notices";

export interface ArchivedThreadsSettingsProps {
  hostId: string;
  load(hostId: string): Promise<ReadonlyArray<{ id: string; name?: string | null; preview?: string }>>;
  restore(hostId: string, threadId: string): Promise<void>;
}

export function ArchivedThreadsSettings({ hostId, load, restore }: ArchivedThreadsSettingsProps) {
  const query = useQuery({ queryKey: ["appserver", hostId, "threads", "archived", "management"], queryFn: () => load(hostId) });
  const [busy, setBusy] = useState<string | null>(null);
  const notices = useAsyncNotices();
  const intl = useIntl();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const empty = !query.isPending && query.error == null && query.data?.length === 0;
  const title = intl.formatMessage({ id: "settings.archived", defaultMessage: "Archived conversations" });
  return <>
    <SettingsPageHeader title={title} />
    {query.isPending ? <SettingsNotice role="status">{intl.formatMessage({ id: "settings.archived.loading", defaultMessage: "Loading archived conversations…" })}</SettingsNotice> : null}
    {query.error ? <SettingsNotice role="alert" tone="error">{query.error.message}</SettingsNotice> : null}
    {empty ? <SettingsNotice>{intl.formatMessage({ id: "settings.archived.empty", defaultMessage: "No archived conversations." })}</SettingsNotice> : null}
    {query.data?.length ? <SettingsGroup aria-label={title}>
      {query.data.map(thread => {
        const row = archivedConversationLabel(thread, intl.formatMessage({ id: "sidebar.newChat", defaultMessage: "New chat" }));
        return <SettingsListItem
        key={thread.id}
        label={row.label}
        description={row.description}
        actions={<SettingsButton
          disabled={busy !== null}
          aria-busy={busy === thread.id}
          onClick={() => {
            setBusy(thread.id);
            void restore(hostId, thread.id)
              .catch(() => {
                if (mounted.current) notices.error({ key: `restore:${hostId}:${thread.id}`, detail: thread.name ?? thread.preview,
                  message: intl.formatMessage({ id: "tasks.relation.saveError", defaultMessage: "Could not confirm the change. Review the current selection and retry." }) });
              })
              .finally(() => { if (mounted.current) setBusy(null); });
          }}
        >{busy === thread.id
          ? intl.formatMessage({ id: "chat.archived.restoring", defaultMessage: "Restoring…" })
          : intl.formatMessage({ id: "chat.archived.restore", defaultMessage: "Restore conversation" })}</SettingsButton>}
      />;
      })}
    </SettingsGroup> : null}
    {empty || query.error ? <SettingsActions>
      <SettingsButton type="button" onClick={() => { void query.refetch(); }}>{intl.formatMessage({ id: "settings.archived.refresh", defaultMessage: "Refresh" })}</SettingsButton>
    </SettingsActions> : null}
  </>;
}
