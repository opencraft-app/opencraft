import {
  NavigationList,
  NavigationItem,
} from "@opencraft/design-system-web/navigation";
import type { ExtensionSettingsViewProps } from "@opencraft/extension-react";
import { useIntl } from "@opencraft/i18n/react";
import { ASSETS_VIEW_ID } from "./navigation";
export function AssetsEntry({ host }: ExtensionSettingsViewProps) {
  const intl = useIntl(),
    title = intl.formatMessage({
      id: "assets.title",
      defaultMessage: "Assets",
    });
  return (
    <NavigationList label={title} inset="contained">
      <NavigationItem
        aria-current={
          host.activeView?.viewId === ASSETS_VIEW_ID ? "page" : undefined
        }
        onClick={() => host.openView(ASSETS_VIEW_ID)}
      >
        <svg
          className="sidebar-section-icon"
          data-section="assets"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path className="f" d="m12 3.5 8 4.6v7.8l-8 4.6-8-4.6V8.1z" />
          <path d="m12 3.5 8 4.6v7.8l-8 4.6-8-4.6V8.1zM4 8.1l8 4.6 8-4.6M12 12.7v7.8M8 5.8l8 4.6" />
        </svg>
        <span data-navigation-label="">{title}</span>
      </NavigationItem>
    </NavigationList>
  );
}
