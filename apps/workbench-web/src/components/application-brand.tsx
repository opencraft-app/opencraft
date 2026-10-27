import { DEFAULT_APPLICATION_BRANDING, type ApplicationBrandingContribution } from "@opencraft/extension-contract";
import { useIntl } from "@opencraft/i18n/react";
import type { ReactNode } from "react";
import { serverUrl } from "../runtime/server-context";
import { useDismissSidebarAfterSelection } from "./shell-presentation";

export function ApplicationBrand({ branding = DEFAULT_APPLICATION_BRANDING, onHome }: {
  readonly branding?: ApplicationBrandingContribution;
  readonly onHome?: () => void;
}) {
  const content = <>
    {branding.markUrl && <img aria-hidden="true" alt="" width={26} height={26} src={serverUrl(branding.markUrl)} className="application-brand__mark" />}
    <span className="application-brand__wordmark">{branding.name}</span>
  </>;
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
  return <button type="button" className="application-brand no-drag"
    data-mobile-mark={branding.showMarkOnMobile === false ? "hidden" : undefined}
    aria-label={`${branding.name} · ${home}`} title={home} onClick={() => {
      onHome();
      dismissSidebar?.();
    }}>{children}</button>;
}
