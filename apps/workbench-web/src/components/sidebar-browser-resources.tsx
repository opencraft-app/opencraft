import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { GlobeIcon, CloseIcon } from "@opencraft/design-system-web/action-icons";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import { useOptionalBrowserRuntime } from "../browser/browser-runtime-context";
import type { BrowserWorkbenchCoordinator } from "../browser/browser-workbench-coordinator";
import { useAsyncNotices } from "./async-notices";
import { useWorkbenchPresentationRoot } from "./workbench-presentation-root";
import { useSidebarRowMenu } from "./sidebar-thread-menu";
import type { SidebarThreadMenuStore } from "./sidebar-thread-menu-state";

interface Props {
  readonly store: SidebarThreadMenuStore;
  readonly hostId: string;
  readonly threadId: string;
  readonly unavailable: boolean;
  readonly onOpenConversation: () => void;
}

/** Read the existing directory; rendering a conversation never opens its pages. */
export function SidebarBrowserResources(props: Props) {
  const runtime = useOptionalBrowserRuntime();
  return runtime ? <ConversationBrowserResources {...props} workbench={runtime.workbench} /> : null;
}

function ConversationBrowserResources({ store, hostId, threadId, unavailable, onOpenConversation, workbench }: Props & { workbench: BrowserWorkbenchCoordinator }) {
  const subscribe = useCallback((listener: () => void) => workbench.subscribeConversationTabs(hostId, threadId, listener), [workbench, hostId, threadId]);
  const snapshot = useCallback(() => workbench.getConversationTabs(hostId, threadId), [workbench, hostId, threadId]);
  const tabs = useSyncExternalStore(subscribe, snapshot, snapshot);
  const kind = useSidebarRowMenu(store, { hostId, threadId }), open = kind === "resources";
  const intl = useIntl(), notices = useAsyncNotices(), portal = useWorkbenchPresentationRoot();
  useEffect(() => () => store.update({ hostId, threadId, kind: "resources" }, false), [store, hostId, threadId]);
  useEffect(() => { if (!tabs.length && open) store.update({ hostId, threadId, kind: "resources" }, false); }, [store, hostId, threadId, tabs.length, open]);
  if (!tabs.length) return null;
  const label = intl.formatMessage({ id: "sidebar.browser.tabs", defaultMessage: "{count, plural, one {# browser tab} other {# browser tabs}}" }, { count: tabs.length });
  const run = (action: () => void) => {
    try { action(); } catch {
      notices.error({ key: `browser-resources:${hostId}:${threadId}`, message: intl.formatMessage({ id: "sidebar.browser.failed", defaultMessage: "Could not update browser tabs. Try again." }) });
    }
  };
  return <DropdownMenu.Root modal={false} open={open} onOpenChange={value => store.update({ hostId, threadId, kind: "resources" }, value)}>
    <DropdownMenu.Trigger asChild><button type="button" className="sidebar-browser-resources" aria-label={label} title={label}
      onPointerDown={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
      <GlobeIcon size={14} aria-hidden="true" /><span>{tabs.length}</span>
    </button></DropdownMenu.Trigger>
    <DropdownMenu.Portal container={portal}><DropdownMenu.Content className="workbench-context-menu sidebar-browser-resources-menu" align="end" sideOffset={4}
      onPointerDown={event => event.stopPropagation()}
      onCloseAutoFocus={event => { if (store.getSnapshot() !== null) event.preventDefault(); }}>
      <DropdownMenu.Label className="sidebar-display-mode-label">{label}</DropdownMenu.Label>
      {tabs.map(tab => <DropdownMenu.Item key={tab.tabId} disabled={unavailable} title={tab.url ?? undefined} onSelect={() => run(() => {
        onOpenConversation(); workbench.open(tab.ownerId, { tabId: tab.tabId });
      })}><GlobeIcon size={16} aria-hidden="true" /><span className="sidebar-browser-resources-menu__title">{tab.title || tab.url || intl.formatMessage({ id: "panel.newBrowser", defaultMessage: "New browser tab" })}</span></DropdownMenu.Item>)}
      <DropdownMenu.Separator />
      <DropdownMenu.Item onSelect={() => run(() => {
        for (const tab of workbench.getConversationTabs(hostId, threadId)) workbench.close(tab.ownerId, tab.tabId);
      })}><CloseIcon size={16} aria-hidden="true" />{intl.formatMessage({ id: "sidebar.browser.closeAll", defaultMessage: "Close all browser tabs" })}</DropdownMenu.Item>
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
