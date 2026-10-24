import { useSyncExternalStore } from "react";
import type { ExtensionContributionStore } from "@opencraft/extension-runtime";
import type { ExtensionSettingsViewProps, PlatformViewRendererRegistry } from "@opencraft/extension-react";
import { useIntl } from "@opencraft/i18n/react";
import { projectMiniApps } from "../../runtime/mini-apps";
import { useInternalDeveloperMode } from "../../internal-developer-mode";
import { WorkbenchIcon } from "../../components/ui/workbench-icon";
import "./styles.scss";

/** Overhome owns discovery and launch. Each miniapp retains its data and lifecycle. */
export function OverhomeDesktop({ host, contributions, renderers }: ExtensionSettingsViewProps & {
  readonly contributions: ExtensionContributionStore;
  readonly renderers: PlatformViewRendererRegistry;
}) {
  const intl = useIntl();
  const internal = useInternalDeveloperMode();
  const snapshot = useSyncExternalStore(contributions.subscribe, contributions.getSnapshot);
  useSyncExternalStore(renderers.subscribe, renderers.getSnapshot);
  const apps = projectMiniApps(snapshot, host.platform, internal, type => renderers.resolve(type) !== null);
  const title = intl.formatMessage({ id: "navigation.applications", defaultMessage: "Applications" });
  return <main className="overhome" aria-label={title}>
    <div className="overhome__content">
      <header className="overhome__heading">
        <h1>{title}</h1>
        <p>{intl.formatMessage({ id: "overhome.description", defaultMessage: "Your apps, all in one place." })}</p>
      </header>
      <ul className="overhome__grid" aria-label={title}>
        {apps.map(app => {
          const label = app.titleMessage ? intl.formatMessage(app.titleMessage) : app.title;
          return <li key={app.id}>
            <button type="button" className="overhome__app" data-miniapp-id={app.id} onClick={() => {
              if (app.target.kind === "settings") host.openSettings?.(app.target.pageId);
              else host.openView(app.target.viewId);
            }}>
              <span className="overhome__icon" aria-hidden="true"><WorkbenchIcon name={app.icon} size={36} purpose="work" /></span>
              <span className="overhome__label">{label}</span>
            </button>
          </li>;
        })}
      </ul>
      {apps.length === 0 ? <p className="overhome__empty" role="status">{intl.formatMessage({
        id: "overhome.empty", defaultMessage: "Your apps will appear here." })}</p> : null}
    </div>
  </main>;
}
