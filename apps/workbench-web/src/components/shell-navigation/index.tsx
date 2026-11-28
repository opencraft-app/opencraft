import { NavigationStrip } from "./navigation-strip";
import { shellNavigationLabels } from "./navigation-labels";
import { ShellNavigationButton } from "./navigation-button";
import * as Popover from "@radix-ui/react-popover";
import { useWorkbenchPresentationRoot } from "../workbench-presentation-root";
import { useShellPresentation } from "../shell-presentation";
import { useIntl } from "@opencraft/i18n/react";
import { NavigationIcon } from "./navigation-action";
import { AccountSignInMenu } from "./account-sign-in-menu";
import { hasManagedWebUpdates, currentPlatform, useManagedWebUpdateNotice } from "../web-updates-settings";
import { lazy, Suspense, useEffect, useState } from "react";
import {
  AccountLeadingVisual,
  isAnonymousShellAccount,
  NavigationContent,
  shellAccountEntranceLabel,
  type ShellNavigationConfig,
} from "./navigation-content";
const LazyValdiSidebarOrb = lazy(() =>
  import("./valdi-sidebar-dock").then((m) => ({ default: m.ValdiSidebarOrb })),
);
const LazyValdiSidebarTabDock = lazy(() =>
  import("./valdi-sidebar-dock").then((m) => ({ default: m.ValdiSidebarTabDock })),
);

export type { ShellNavigationConfig } from "./navigation-content";
const accountHeading = { id: "account.title", defaultMessage: "Account" };

export function ShellSidebarNavigation({ config, onInvoke }: {
  config: ShellNavigationConfig;
  onInvoke: (action: () => void) => void;
}) {
  const mobile = useShellPresentation()?.mobileSidebar ?? false;
  const fallback = <NavigationStrip>
    <NavigationContent config={config} surface="applications" compact includeSettings={false}
      shortLabel tooltipSide="top" onInvoke={onInvoke} />
  </NavigationStrip>;
  return <div className="shell-sidebar-navigation">
    {mobile ? fallback : (
      <Suspense fallback={fallback}>
        <LazyValdiSidebarTabDock config={config} onInvoke={onInvoke} fallback={fallback} />
      </Suspense>
    )}
  </div>;
}

/** Shared accessory owner for the docked and floating sidebar. */
export function ShellNavigationFooter({ config, visible, mobile, entranceId, onInvoke }: {
  config: ShellNavigationConfig;
  visible: boolean;
  mobile: boolean;
  entranceId: string;
  onInvoke: (action: () => void) => void;
}) {
  const intl = useIntl();
  const mobileApplications = mobile && config.applicationsInSidebar
    ? config.actions.find(action => action.id === "shell.applications") : undefined;
  const managedUpdateEntrance = currentPlatform() === "web" && hasManagedWebUpdates()
    ? <ShellManagedUpdateEntrance mobile={mobile} selected={config.updatesActive} onInvoke={onInvoke}
      onOpenUpdates={config.onOpenUpdates} onOpenSettings={config.onOpenSettings} />
    : null;
  return <div className="shell-navigation__footer shell-navigation__footer--unified" aria-label="Application entrances">
    {managedUpdateEntrance}
    {mobileApplications ? <ShellNavigationButton contentLayout="icon" surface="floating"
      type="button" className="shell-navigation__entrance" data-surface="applications" data-action-id="shell.applications"
      aria-label={shellNavigationLabels(mobileApplications, intl).full}
      title={shellNavigationLabels(mobileApplications, intl).full}
      aria-expanded={mobileApplications.expanded} aria-current={mobileApplications.active ? "page" : undefined}
      onClick={() => onInvoke(mobileApplications.onInvoke)}>
      <NavigationIcon name={mobileApplications.icon} selected={mobileApplications.active} />
    </ShellNavigationButton> : null}
    <ShellNavigationButton contentLayout="icon" surface={mobile ? "floating" : "integrated"}
      type="button" className="shell-navigation__entrance" data-surface="settings"
      aria-label={intl.formatMessage({ id: "settings.title", defaultMessage: "Settings" })}
      title={intl.formatMessage({ id: "settings.title", defaultMessage: "Settings" })}
      aria-current={config.settingsActive ? "page" : undefined} onClick={() => onInvoke(config.onOpenSettings)}>
      {mobile ? (
        <NavigationIcon name="settings" selected={config.settingsActive} />
      ) : (
        <Suspense fallback={<NavigationIcon name="settings" selected={config.settingsActive} />}>
          <LazyValdiSidebarOrb
            icon="settings"
            active={Boolean(config.settingsActive)}
            chromeless
            fallback={<NavigationIcon name="settings" selected={config.settingsActive} />}
          />
        </Suspense>
      )}
    </ShellNavigationButton>
    <ShellAccountEntrance config={config} visible={visible} mobile={mobile} id={`${entranceId}-account`} onInvoke={onInvoke} />
  </div>;
}

function ShellAccountEntrance({ config, visible, mobile, id, onInvoke }: {
  config: ShellNavigationConfig;
  visible: boolean;
  mobile: boolean;
  id: string;
  onInvoke: (action: () => void) => void;
}) {
  const intl = useIntl();
  const presentationRoot = useWorkbenchPresentationRoot();
  const [open, setOpen] = useState(false);
  const { account } = config;
  const anonymous = isAnonymousShellAccount(account);
  const label = shellAccountEntranceLabel(account, intl);
  const canShowMenu = visible && account !== null && !anonymous;
  useEffect(() => {
    if (!canShowMenu) setOpen(false);
  }, [canShowMenu]);
  if (account === null || label === null) return null;
  if (anonymous && account.signIn) return <AccountSignInMenu
    account={account} signIn={account.signIn} id={id}
    floating={mobile} visible={visible} container={presentationRoot} onOpenSettings={() => onInvoke(config.onOpenSettings)} />;

  const entrance = <ShellNavigationButton contentLayout="icon" surface={mobile ? "floating" : "integrated"}
    id={id} type="button" className="shell-navigation__entrance" aria-label={label} title={label}
    data-surface="account" {...(anonymous ? { onClick: account.onOpen } : {})}>
    <AccountLeadingVisual account={account} /><span className="shell-navigation__name">{label}</span>
  </ShellNavigationButton>;
  if (anonymous) return entrance;

  return <Popover.Root modal={false} open={visible && open} onOpenChange={setOpen}>
    <Popover.Trigger asChild>{entrance}</Popover.Trigger>
    <Popover.Portal container={presentationRoot}>
      <Popover.Content className="shell-navigation__peek" aria-label={intl.formatMessage(accountHeading)}
        side="top" align="start" sideOffset={8} collisionPadding={12}>
        <div className="shell-navigation__heading"><h2>{intl.formatMessage(accountHeading)}</h2></div>
        <NavigationContent config={config} surface="account" onInvoke={action => {
          setOpen(false);
          onInvoke(action);
        }} />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

/** Self-contained managed website update entrance: the only subtree that asks
 * the release feed, so it alone needs the query runtime and the site's update
 * metadata. Other shells never mount it and never build the notice. */
function ShellManagedUpdateEntrance({ selected, onInvoke = action => action(), onOpenUpdates, onOpenSettings, mobile }: {
  mobile: boolean;
  selected?: boolean; onInvoke?: (action: () => void) => void;
  onOpenUpdates?: () => void; onOpenSettings: () => void;
}) {
  const intl = useIntl();
  const notice = useManagedWebUpdateNotice();
  if (!notice.visible) return null;
  const updateTitle = notice.updateAvailable
    ? intl.formatMessage(
        { id: "webUpdates.noticeAvailable", defaultMessage: "Update available (v{version}), click to download" },
        { version: notice.latestVersion ?? "" },
      )
    : intl.formatMessage({ id: "webUpdates.noticeRefresh", defaultMessage: "New version ready, click to refresh" });
  const updateActionText = notice.updateAvailable
    ? intl.formatMessage(
        { id: "webUpdates.noticeAction", defaultMessage: "Download update v{version}" },
        { version: notice.latestVersion ?? "" },
      )
    : intl.formatMessage({ id: "webUpdates.noticeRefreshAction", defaultMessage: "Refresh update" });
  return <ShellNavigationButton contentLayout={mobile ? "icon" : "row"} surface={mobile ? "floating" : "integrated"} type="button" className="shell-navigation__entrance shell-navigation__entrance--update"
    data-surface="updates"
    data-update-version={notice.latestVersion ?? undefined}
    aria-label={updateTitle}
    title={updateTitle}
    aria-current={selected ? "page" : undefined}
    onClick={() => {
      if (onOpenUpdates) onInvoke(onOpenUpdates);
      else onInvoke(onOpenSettings);
    }}>

    <span className="shell-navigation__icon-wrapper">
      <NavigationIcon name={notice.updateAvailable ? "updates" : "refresh"} selected={selected} />
      <span className="shell-navigation__update-dot" aria-hidden="true" />
    </span>
    <span className="shell-navigation__name">{updateActionText}</span>
  </ShellNavigationButton>;
}
