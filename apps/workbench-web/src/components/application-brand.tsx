import { DEFAULT_APPLICATION_BRANDING, type ApplicationBrandingContribution } from "@opencraft/extension-contract";
import { useIntl } from "@opencraft/i18n/react";
import type { ReactNode } from "react";
import { ServerIcon } from "@opencraft/design-system-web/action-icons";
import { Button } from "@opencraft/design-system-web/button";
import { browserServerContext, serverUrl } from "../runtime/server-context";
import { useDismissSidebarAfterSelection } from "./shell-presentation";

export function ApplicationBrand({ branding = DEFAULT_APPLICATION_BRANDING, onHome }: {
  readonly branding?: ApplicationBrandingContribution;
  readonly onHome?: () => void;
}) {
  const intl = useIntl();
  const server = onHome ? browserServerContext() : null;
  const content = <>
    {branding.markUrl && <img aria-hidden="true" alt="" width={26} height={26} src={serverUrl(branding.markUrl)} className="application-brand__mark" />}
    <span className="application-brand__wordmark">{branding.name}</span>
  </>;
  if (server) {
    const label = intl.formatMessage({ id: "navigation.switchServer", defaultMessage: "Switch server" });
    return <Button className="application-brand no-drag" data-brand-action="switch-server" size="toolbar" variant="ghost" contentLayout="row"
      data-mobile-mark={branding.showMarkOnMobile === false ? "hidden" : undefined}
      aria-label={`${label} · ${server.name}`} title={`${server.name} · ${label}`}
      onClick={() => window.location.assign(server.selectorPath)}>
      {content}<ServerIcon aria-hidden="true" size={16} className="application-brand__switch-icon" />
    </Button>;
  }
  return onHome ? <HomeBrand branding={branding} onHome={onHome}>{content}</HomeBrand>
    : <span className="application-brand" data-mobile-mark={branding.showMarkOnMobile === false ? "hidden" : undefined} role="img" aria-label={branding.name}>{content}</span>;
}

function HomeBrand({ branding, onHome, children }: {
  readonly branding: ApplicationBrandingContribution;
  readonly onHome: () => void;
  readonly children: ReactNode;
}) {
  const intl = useIntl();
  const dismissSidebar = useDismissSidebarAfterSelection();
  const home = intl.formatMessage({ id: "navigation.home", defaultMessage: "Home" });
  return <Button size="toolbar" variant="ghost" contentLayout="row" className="application-brand no-drag"
    data-mobile-mark={branding.showMarkOnMobile === false ? "hidden" : undefined}
    aria-label={`${branding.name} · ${home}`} title={home} onClick={() => {
      onHome();
      dismissSidebar?.();
    }}>{children}</Button>;
}
