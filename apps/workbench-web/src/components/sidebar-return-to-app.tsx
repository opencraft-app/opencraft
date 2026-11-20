import { createPortal } from "react-dom";
import { ShellNavigationButton } from "./shell-navigation/navigation-button";
import { ArrowLeftIcon } from "@opencraft/design-system-web/action-icons";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import { useShellPresentation } from "./shell-presentation";

/** Return to the conversation list in place; selecting a conversation owns dismissal. */
export function SidebarReturnToApp({ onReturn }: { readonly onReturn: () => void }) {
  const intl = useIntl();
  const shell = useShellPresentation();
  if (!shell?.mobileSidebar || !shell.sidebarActionHost) return null;
  return createPortal(<ShellNavigationButton type="button" contentLayout="row" surface="floating"
    className="shell-sidebar-primary-action settings-return-to-app"
    title={intl.formatMessage({ id: "settings.back", defaultMessage: "Back to app" })}
    onClick={onReturn}>
    <ArrowLeftIcon size={20} aria-hidden="true" /><span><FormattedMessage id="settings.back" defaultMessage="Back to app" /></span>
  </ShellNavigationButton>, shell.sidebarActionHost);
}
