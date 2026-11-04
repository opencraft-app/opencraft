import { createPortal } from "react-dom";
import { Button } from "@opencraft/design-system-web/button";
import { ArrowLeftIcon } from "@opencraft/design-system-web/action-icons";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import { useShellPresentation } from "./shell-presentation";

/** A peer sidebar uses the same primary action slot as conversation creation. */
export function SidebarReturnToApp({ onReturn }: { readonly onReturn: () => void }) {
  const intl = useIntl();
  const shell = useShellPresentation();
  if (!shell?.mobileSidebar || !shell.sidebarActionHost) return null;
  return createPortal(<Button type="button" size="navigation" variant="ghost" contentLayout="row" surface="floating"
    className="shell-sidebar-primary-action settings-return-to-app"
    title={intl.formatMessage({ id: "settings.back", defaultMessage: "Back to app" })}
    onClick={() => { onReturn(); shell.dismissSidebarAfterSelection(); }}>
    <ArrowLeftIcon size={20} aria-hidden="true" /><span><FormattedMessage id="settings.back" defaultMessage="Back to app" /></span>
  </Button>, shell.sidebarActionHost);
}
