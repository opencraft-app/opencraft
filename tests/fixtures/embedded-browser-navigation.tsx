import { createRoot } from "react-dom/client";
import { LocaleRuntime } from "@opencraft/i18n";
import { IntlRuntimeProvider } from "@opencraft/i18n/react";
import { createConversationBindingStore } from "@opencraft/workbench-runtime";
import { ExternalUrlLink } from "../../packages/chat-render-web/src/renderers/resource-link/resource-link";
import { BrowserWorkbenchCoordinator } from "../../apps/workbench-web/src/browser/browser-workbench-coordinator";
import { WebBrowserPageRuntime, type BrowserNavigationPolicy } from "../../apps/workbench-web/src/browser/web-browser-runtime";
import { WebIframeSurfaceHost } from "../../apps/workbench-web/src/browser/web-browser-surface-host";

// Real link renderer, resource coordinator, Page runtime and iframe host. The
// panel chrome and remote pages are fixtures; no account or live Host is used.
const surfaces = new WebIframeSurfaceHost();
surfaces.setRoot(document.getElementById("surfaces")!);
// The containing product supplies policy. This public probe uses reserved
// synthetic origins instead of importing a downstream product bootstrap.
const navigationPolicy: BrowserNavigationPolicy = {
  canEmbed(url) {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && (hostname === "workbench.example" || hostname.endsWith(".workbench.example"));
  },
  openExternal(url) { window.open(url, "_blank", "noopener,noreferrer"); },
};
const pages = new WebBrowserPageRuntime(surfaces, null, () => null, null, navigationPolicy);
const panelOpens: string[] = [];
const coordinator = new BrowserWorkbenchCoordinator(pages, {
  open(owner: string) { panelOpens.push(owner); return { id: `panel-${panelOpens.length}` }; }, dispatch() {}, close() {},
} as never, createConversationBindingStore());
coordinator.restorePersistedTabs();
const targets = {
  allowed: "https://workbench.example/preview",
  subdomain: "https://preview.workbench.example/app",
  external: "https://example.org/away",
  lookalike: "https://workbench.example.evil.example/away",
};
let currentPage: Parameters<typeof pages.navigate>[0] | undefined;
const context = {
  streaming: false,
  openResource(target: string, _decision: unknown, intent?: { target?: string }) {
    if (intent?.target === "external-browser") { window.open(target, "_blank", "noopener,noreferrer"); return; }
    const opened = coordinator.open("conversation-fixture", { initialUrl: target, background: true });
    if (opened) currentPage = opened.pageId;
  },
};
const locale = new LocaleRuntime([]);
await locale.update({ ideLocale: "en-US" });
createRoot(document.getElementById("root")!).render(<IntlRuntimeProvider runtime={locale}>
  <textarea aria-label="Conversation draft" defaultValue="Keep my unsent draft" />
  {Object.entries(targets).map(([label, target]) => <ExternalUrlLink key={label}
    context={context as never} decision={{ kind: "external", allowed: true, target } as never}
    label={label} title={label} />)}
  <form onSubmit={event => {
    event.preventDefault();
    if (currentPage) pages.navigate(currentPage, new FormData(event.currentTarget).get("url") as string);
  }}><input name="url" aria-label="Browser address" /><button>Navigate</button></form>
</IntlRuntimeProvider>);
Object.assign(window, { __browserFixture: {
  snapshot: () => ({ pages: pages.list(), tabs: coordinator.listForOwner("conversation-fixture"), panelOpens }),
  openRetained: () => {
    for (const { tab } of coordinator.listForOwner("conversation-fixture")) coordinator.open(tab.ownerId, { tabId: tab.id, background: true });
  },
  closeRetained: () => coordinator.disposeOwner("conversation-fixture"),
} });
