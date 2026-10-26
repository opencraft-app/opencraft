import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { ExtensionContributionStore } from "@opencraft/extension-runtime";
import type { ExtensionSettingsViewProps, PlatformViewRendererRegistry } from "@opencraft/extension-react";
import { applicationDesktopMotion } from "@opencraft/design-system/tokens";
import { useIntl } from "@opencraft/i18n/react";
import { projectMiniApps } from "../../runtime/mini-apps";
import { useInternalDeveloperMode } from "../../internal-developer-mode";
import { WorkbenchIcon } from "../../components/ui/workbench-icon";
import { useApplicationDesktop } from "../../components/application-desktop-motion";
import "./styles.scss";

/** Discovery and launch only; each miniapp retains its own data and lifecycle. */
export function OverhomeDesktop({ host, contributions, renderers }: ExtensionSettingsViewProps & {
  readonly contributions: ExtensionContributionStore;
  readonly renderers: PlatformViewRendererRegistry;
}) {
  const intl = useIntl(), internal = useInternalDeveloperMode(), desktop = useApplicationDesktop();
  const reducedMotion = useReducedMotion();
  const [query, setQuery] = useState(""), [searching, setSearching] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null), searchButton = useRef<HTMLButtonElement>(null);
  const wasSearching = useRef(false);
  useLayoutEffect(() => {
    if (wasSearching.current && !searching) searchButton.current?.focus({ preventScroll: true });
    wasSearching.current = searching;
  }, [searching]);
  const snapshot = useSyncExternalStore(contributions.subscribe, contributions.getSnapshot);
  useSyncExternalStore(renderers.subscribe, renderers.getSnapshot);
  const apps = projectMiniApps(snapshot, host.platform, internal, type => renderers.resolve(type) !== null);
  const title = intl.formatMessage({ id: "navigation.applications", defaultMessage: "Applications" });
  const searchLabel = intl.formatMessage({ id: "overhome.search", defaultMessage: "Search" });
  const visibleApps = apps.filter(app => (app.titleMessage ? intl.formatMessage(app.titleMessage) : app.title)
    .toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <main className="overhome" data-shell-wallpaper={desktop !== null || undefined} aria-label={title}>
    <h1 className="overhome__accessible-title">{title}</h1>
    <div className="overhome__content">
      <ul className="overhome__grid" aria-label={title}>
        {visibleApps.map((app, index) => {
          const label = app.titleMessage ? intl.formatMessage(app.titleMessage) : app.title;
          return <motion.li key={app.id} initial={reducedMotion ? false : { opacity: 0, y: applicationDesktopMotion.iconEntryY, scale: applicationDesktopMotion.iconEntryScale }}
            animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ ...applicationDesktopMotion.press, delay: Math.min(index, 12) * applicationDesktopMotion.iconStagger }}>
            <motion.button type="button" className="overhome__app" data-miniapp-id={app.id}
              whileTap={reducedMotion ? undefined : { scale: applicationDesktopMotion.pressScale }} transition={applicationDesktopMotion.press}
              onClick={event => {
                const open = () => app.target.kind === "settings" ? host.openSettings?.(app.target.pageId) : host.openView(app.target.viewId);
                const icon = event.currentTarget.querySelector<HTMLElement>(".overhome__icon")!;
                if (desktop) desktop.start(app, icon, open); else open();
              }}>
              <span className="overhome__icon" aria-hidden="true"><WorkbenchIcon name={app.icon} size={36} purpose="navigation" /></span>
              <span className="overhome__label">{label}</span>
            </motion.button>
          </motion.li>;
        })}
      </ul>
      {visibleApps.length === 0 ? <p className="overhome__empty" role="status">{query.trim() ? intl.formatMessage({ id: "overhome.noMatches", defaultMessage: "No apps found." }) : intl.formatMessage({
        id: "overhome.empty", defaultMessage: "Your apps will appear here." })}</p> : null}
    </div>
    <footer className="overhome__footer">
      <div className="overhome__search">
        {searching ? <label className="overhome__search-field"><WorkbenchIcon name="search" size={16} />
          <input ref={searchInput} autoFocus type="search" value={query} aria-label={searchLabel} placeholder={searchLabel}
            onChange={event => setQuery(event.target.value)} onKeyDown={event => {
              if (event.key === "Escape") { setQuery(""); setSearching(false); searchButton.current?.focus(); }
            }} />
        </label> : <button ref={searchButton} type="button" className="overhome__search-button" onClick={() => setSearching(true)}>
          <WorkbenchIcon name="search" size={16} /><span>{searchLabel}</span>
        </button>}
      </div>
      <nav className="overhome__dock" aria-label={title}>
        {desktop ? <motion.button type="button" className="overhome__dock-item" whileTap={reducedMotion ? undefined : { scale: applicationDesktopMotion.pressScale }}
          aria-label={intl.formatMessage({ id: "navigation.chat", defaultMessage: "Chat" })} onClick={desktop.openChat}>
          <span className="overhome__dock-icon overhome__dock-icon--chat"><WorkbenchIcon name="chat" size={32} purpose="navigation" /></span>
        </motion.button> : null}
        <motion.button type="button" className="overhome__dock-item" whileTap={reducedMotion ? undefined : { scale: applicationDesktopMotion.pressScale }}
          aria-label={searchLabel} onClick={() => { setSearching(true); searchInput.current?.focus(); }}>
          <span className="overhome__dock-icon overhome__dock-icon--apps"><WorkbenchIcon name="applications" size={30} purpose="navigation" /></span>
        </motion.button>
        {host.openSettings ? <motion.button type="button" className="overhome__dock-item" whileTap={reducedMotion ? undefined : { scale: applicationDesktopMotion.pressScale }}
          aria-label={intl.formatMessage({ id: "settings.title", defaultMessage: "Settings" })} onClick={() => host.openSettings?.("appearance")}>
          <span className="overhome__dock-icon overhome__dock-icon--settings"><WorkbenchIcon name="settings" size={32} purpose="navigation" /></span>
        </motion.button> : null}
      </nav>
    </footer>
  </main>;
}
