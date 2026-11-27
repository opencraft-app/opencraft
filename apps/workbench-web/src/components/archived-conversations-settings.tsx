import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useIntl } from "@opencraft/i18n/react";
import { SettingsPageHeader } from "@opencraft/extension-react";
import { useAppearanceTheme } from "../appearance-theme";
import { requestMobileHaptic } from "../runtime/mobile-valdi-bridge";
import { archivedConversationLabel } from "../sidebar-activity";
import { useAsyncNotices } from "./async-notices";
import { useValdiTouchDensity } from "./shell-navigation/valdi-sidebar-dock";
import "./valdi-surfaces.scss";

const LazyValdiArchivedThreads = lazy(async () => {
  const mod = await import("@opencraft/design-system-web/valdi");
  function ArchivedThreadsMount({
    viewModel,
  }: {
    readonly viewModel: import("@opencraft/design-system-web/valdi").ArchivedThreadsProps;
  }) {
    return (
      <mod.ValdiSurface
        component={mod.ArchivedThreadsSurface}
        viewModel={viewModel}
        className="valdi-archived-threads-surface"
        data-testid="valdi-archived-threads-surface"
      />
    );
  }
  return { default: ArchivedThreadsMount };
});

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
  const appearance = useAppearanceTheme();
  const touch = useValdiTouchDensity();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const title = intl.formatMessage({ id: "settings.archived", defaultMessage: "Archived conversations" });
  const newChatLabel = intl.formatMessage({ id: "sidebar.newChat", defaultMessage: "New chat" });

  const handleRestore = useCallback(
    (threadId: string) => {
      const target = query.data?.find((item) => item.id === threadId);
      setBusy(threadId);
      void restore(hostId, threadId)
        .catch(() => {
          if (mounted.current) {
            notices.error({
              key: `restore:${hostId}:${threadId}`,
              detail: target?.name ?? target?.preview,
              message: intl.formatMessage({
                id: "tasks.relation.saveError",
                defaultMessage: "Could not confirm the change. Review the current selection and retry.",
              }),
            });
          }
        })
        .finally(() => {
          if (mounted.current) setBusy(null);
        });
    },
    [hostId, intl, notices, query.data, restore],
  );

  const handleRefresh = useCallback(() => {
    void query.refetch();
  }, [query.refetch]);

  const handleHaptic = useCallback((style: string) => {
    requestMobileHaptic(style === "warning" ? "warning" : style === "light" ? "light" : "selection");
  }, []);

  const items = useMemo(
    () =>
      (query.data ?? []).map((thread) => {
        const row = archivedConversationLabel(thread, newChatLabel);
        return {
          id: thread.id,
          title: row.label,
          description: row.description,
          restoring: busy === thread.id,
        };
      }),
    [busy, newChatLabel, query.data],
  );

  const viewModel = useMemo(
    (): import("@opencraft/design-system-web/valdi").ArchivedThreadsProps => ({
      dark: appearance.resolvedTheme === "dark",
      touch,
      title,
      loading: query.isPending,
      loadingText: intl.formatMessage({ id: "settings.archived.loading", defaultMessage: "Loading archived conversations…" }),
      errorMessage: query.error ? query.error.message : undefined,
      emptyText: intl.formatMessage({ id: "settings.archived.empty", defaultMessage: "No archived conversations." }),
      refreshLabel: intl.formatMessage({ id: "settings.archived.refresh", defaultMessage: "Refresh" }),
      restoreLabel: intl.formatMessage({ id: "chat.archived.restore", defaultMessage: "Restore conversation" }),
      restoringLabel: intl.formatMessage({ id: "chat.archived.restoring", defaultMessage: "Restoring…" }),
      items,
      busy: busy !== null,
      onRefresh: handleRefresh,
      onRestore: handleRestore,
      onHaptic: handleHaptic,
    }),
    [appearance.resolvedTheme, busy, handleHaptic, handleRefresh, handleRestore, intl, items, query.error, query.isPending, title, touch],
  );

  return (
    <Suspense fallback={<SettingsPageHeader title={title} />}>
      <LazyValdiArchivedThreads viewModel={viewModel} />
    </Suspense>
  );
}
