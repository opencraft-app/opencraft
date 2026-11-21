import { AssetsIcon } from "@opencraft/design-system-web/action-icons";
import { NavigationList, NavigationItem } from "@opencraft/design-system-web/navigation";
import type { ExtensionSettingsViewProps } from "@opencraft/extension-react";
import { useIntl } from "@opencraft/i18n/react";
import { ASSETS_VIEW_ID } from "./navigation";
export function AssetsEntry({
  host,
  viewId = ASSETS_VIEW_ID,
}: ExtensionSettingsViewProps & { readonly viewId?: string }) {
  const intl = useIntl(),
    title = intl.formatMessage({
      id: "assets.title",
      defaultMessage: "Assets",
    });
  return (
    <NavigationList label={title} inset="contained">
      <NavigationItem
        aria-current={host.activeView?.viewId === viewId ? "page" : undefined}
        onClick={() => host.openView(viewId)}
      >
        <AssetsIcon aria-hidden="true" />
        <span data-navigation-label="">{title}</span>
      </NavigationItem>
    </NavigationList>
  );
}
