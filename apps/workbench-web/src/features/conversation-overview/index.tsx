import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import { useIntl } from "@opencraft/i18n/react";
import type { NavigationAction } from "../../components/shell-navigation/navigation-action";
import { useConversationOverviewEnabled } from "./preference";

export type { ConversationOverviewSource } from "./source";
const Overview = lazy(() => import("./overview").then(module => ({ default: module.ConversationOverview })));

export function useConversationOverview() {
  const intl = useIntl();
  const enabled = useConversationOverviewEnabled();
  const [requested, setRequested] = useState(false);
  useEffect(() => { if (!enabled) setRequested(false); }, [enabled]);
  const close = useCallback(() => setRequested(false), []);
  const title = intl.formatMessage({ id: "overview.title", defaultMessage: "Conversation overview" });
  const action = useMemo<NavigationAction | null>(() => enabled ? {
    id: "shell.overview", title, icon: "grid", onInvoke: () => setRequested(true),
  } : null, [enabled, title]);
  return { action, open: enabled && requested, close };
}

export function ConversationOverview(props: ComponentProps<typeof Overview> & { readonly open: boolean }) {
  return props.open ? <Suspense fallback={null}><Overview {...props} /></Suspense> : null;
}
