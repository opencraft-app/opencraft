import * as Dialog from "@radix-ui/react-dialog";
import { useIntl } from "@opencraft/i18n/react";
import { NavigationIcon } from "./navigation-action";
import { AccountSignInMenu } from "./account-sign-in-menu";
import { hasManagedWebUpdates, currentPlatform, useManagedWebUpdateNotice } from "../web-updates-settings";
import {
  motion,
  useTransform,
  type MotionStyle,
  type MotionValue,
} from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useUiPreferencesRuntime } from "../../runtime/ui-preferences-runtime";
import {
  createShellNavigationState, projectShellNavigation, reduceShellNavigation,
  resolveShellNavigationWidth, shellNavigationMetrics,
  resolveShellSpace,
  type ShellNavigationRailDetent,
} from "@opencraft/workbench-runtime";
import {
  AccountLeadingVisual,
  isAnonymousShellAccount,
  NavigationContent,
  shellAccountEntranceLabel,
  type ShellNavigationConfig,
} from "./navigation-content";

export type { ShellNavigationConfig } from "./navigation-content";
const surfaces = ["applications", "account"] as const;
const labels = {
  applications: { id: "navigation.applications", defaultMessage: "Applications" },
  account: { id: "account.title", defaultMessage: "Account" },
};

/** Web storage/layout adapter; no route, Host or Thread state is owned here. */
export function useShellNavigation(input: {
  viewportWidth: number;
  contextWidth: number;
  contextMinimumWidth?: number;
  contextAvailable: boolean;
  sidecarOpen: boolean;
  enabled: boolean;
  allowDock?: boolean;
  rightPanelOpen?: boolean;
  rightPanelFullWidth?: boolean;
  accountAvailable?: boolean;
  unified?: boolean;
}) {
  const preferences = useUiPreferencesRuntime();
  const preferenceSnapshot = useSyncExternalStore(
    preferences.subscribe,
    preferences.getSnapshot,
    preferences.getSnapshot,
  );
  const restoredState = () => createShellNavigationState({
    applications: preferenceSnapshot.values["shell.applicationsPinned"],
    account: preferenceSnapshot.values["shell.accountPinned"],
    railDetent: preferenceSnapshot.values["shell.navigationDetent"],
    lastVisibleRailDetent: preferenceSnapshot.values["shell.lastVisibleNavigationDetent"],
  });
  const [state, dispatch] = useReducer(reduceShellNavigation, undefined, restoredState);
  const [width, setWidth] = useState(() => resolveShellNavigationWidth(
    preferenceSnapshot.values["shell.navigationWidth"],
  ));
  const commitWidth = useCallback((next: number) => {
    const resolved = resolveShellNavigationWidth(next);
    setWidth(resolved);
    void preferences.set("shell.navigationWidth", resolved).catch((error) => {
      console.error("Could not save navigation width", error);
    });
  }, [preferences]);
  const [previouslyAvailable, setPreviouslyAvailable] = useState<boolean>();
  const [previousLevel, setPreviousLevel] = useState<number>();
  const space = input.rightPanelOpen === undefined ? undefined : resolveShellSpace({
    width: input.viewportWidth,
    navigationOpen: !input.unified && input.enabled && input.allowDock !== false && input.sidecarOpen
      && (!input.contextAvailable || state.pinned.applications || (input.accountAvailable !== false && state.pinned.account)),
    navigationDetent: state.railDetent, navigationWidth: width,
    contextOpen: input.sidecarOpen && input.contextAvailable, contextWidth: input.contextWidth, contextMinimumWidth: input.contextMinimumWidth,
    rightOpen: input.rightPanelOpen, rightFullWidth: input.rightPanelFullWidth === true,
    previousLevel,
  });
  useLayoutEffect(() => setPreviousLevel(space?.level), [space?.level]);
  const projection = projectShellNavigation({ ...input, state, space, previouslyAvailable, navigationWidth: width,
    allowDock: input.enabled && input.allowDock !== false });
  useLayoutEffect(() => setPreviouslyAvailable(projection.dockAvailable), [projection.dockAvailable]);
  useEffect(() => {
    const next = restoredState();
    if (
      next.pinned.applications !== state.pinned.applications
      || next.pinned.account !== state.pinned.account
      || next.railDetent !== state.railDetent
      || next.lastVisibleRailDetent !== state.lastVisibleRailDetent
    ) dispatch({ type: "restore-preferences", preferences: {
      applications: next.pinned.applications,
      account: next.pinned.account,
      railDetent: next.railDetent,
      lastVisibleRailDetent: next.lastVisibleRailDetent,
    } });
    const nextWidth = resolveShellNavigationWidth(preferenceSnapshot.values["shell.navigationWidth"]);
    if (nextWidth !== width) setWidth(nextWidth);
  }, [preferenceSnapshot.revision]);
  useEffect(() => {
    void Promise.all([
      preferences.set("shell.applicationsPinned", state.pinned.applications),
      preferences.set("shell.accountPinned", state.pinned.account),
      preferences.set("shell.navigationDetent", state.railDetent),
      preferences.set("shell.lastVisibleNavigationDetent", state.lastVisibleRailDetent),
    ]).catch((error) => {
      console.error("Could not save navigation preferences", error);
    });
  }, [preferences, state.pinned, state.railDetent, state.lastVisibleRailDetent]);
  // A peek absorbed into its dock must not reappear on a later resize.
  useEffect(() => {
    if (state.peek && projection.docked[state.peek]) dispatch({ type: "dismiss", surface: state.peek });
  }, [state.peek, projection.docked.applications, projection.docked.account]);
  const commitRailDetent = useCallback((detent: ShellNavigationRailDetent) => {
    dispatch({ type: "set-rail-detent", detent });
  }, []);
  // Explicit user intent may restore a pane inside the automatic resize hysteresis band.
  const requestDock = useCallback(() => setPreviousLevel(undefined), []);
  return { state, projection, space, dispatch, width, commitWidth, commitRailDetent, requestDock };
}
export type ShellNavigationController = ReturnType<typeof useShellNavigation>;

interface ShellNavigationMotionStyle extends MotionStyle {
  "--shell-navigation-content-gap": MotionValue<string>;
  "--shell-navigation-heading-height": MotionValue<string>;
  "--shell-navigation-heading-opacity": MotionValue<number>;
  "--shell-navigation-heading-y": MotionValue<string>;
  "--shell-navigation-label-opacity": MotionValue<number>;
  "--shell-navigation-label-x": MotionValue<string>;
  "--shell-navigation-row-gap": MotionValue<string>;
  "--shell-navigation-row-padding": MotionValue<string>;
  "--shell-navigation-row-inset": MotionValue<string>;
  "--shell-navigation-row-width": MotionValue<string>;
}

function ShellNavigationMotionFrame({ children, expandedWidth, frameWidth }: {
  readonly children: ReactNode;
  readonly expandedWidth: MotionValue<number>;
  readonly frameWidth: MotionValue<number>;
}) {
  const progress = useTransform(
    [frameWidth, expandedWidth],
    ([currentFrameWidth, currentExpandedWidth]) => {
      const span = Math.max(1, Number(currentExpandedWidth) - shellNavigationMetrics.compactWidth);
      return Math.max(0, Math.min(1,
        (Number(currentFrameWidth) - shellNavigationMetrics.compactWidth) / span));
    },
  );
  const labelOpacity = useTransform(progress, [0.38, 0.82], [0, 1], { clamp: true });
  const headingProgress = useTransform(progress, [0.22, 0.86], [0, 1], { clamp: true });
  const style: ShellNavigationMotionStyle = {
    "--shell-navigation-content-gap": useTransform(progress, value => `${8 + value * 16}px`),
    "--shell-navigation-heading-height": useTransform(headingProgress, value => `${value * 34}px`),
    "--shell-navigation-heading-opacity": headingProgress,
    "--shell-navigation-heading-y": useTransform(headingProgress, value => `${(1 - value) * -5}px`),
    "--shell-navigation-label-opacity": labelOpacity,
    "--shell-navigation-label-x": useTransform(labelOpacity, value => `${(1 - value) * -6}px`),
    "--shell-navigation-row-gap": useTransform(progress, value => `${value * 9}px`),
    "--shell-navigation-row-padding": useTransform(progress, () => "8px"),
    "--shell-navigation-row-inset": useTransform(progress, value => {
      const compactInset = (shellNavigationMetrics.compactWidth - shellNavigationMetrics.compactActionSize) / 2;
      return `${compactInset + value * (12 - compactInset)}px`;
    }),
    "--shell-navigation-row-width": useTransform(
      [progress, expandedWidth],
      ([currentProgress, currentExpandedWidth]) => {
        const compactRowWidth = shellNavigationMetrics.compactActionSize;
        const expandedRowWidth = Math.max(compactRowWidth, Number(currentExpandedWidth) - 24);
        return `${compactRowWidth + Number(currentProgress) * (expandedRowWidth - compactRowWidth)}px`;
      },
    ),
  };
  return <motion.div className="shell-navigation__dock-content"
    data-shell-navigation-motion="geometry" style={style}>{children}</motion.div>;
}

export function ShellNavigationDock({ config, controller, expandedWidth, frameWidth, leadingControl, transient = false, onInvoke = action => action() }: {
  config: ShellNavigationConfig; controller: ShellNavigationController;
  expandedWidth?: MotionValue<number>; frameWidth?: MotionValue<number>; transient?: boolean;
  leadingControl?: ReactNode;
  onInvoke?: (action: () => void) => void;
}) {
  const intl = useIntl();
  const compact = !transient && controller.projection.railDetent === "compact";
  if (config.layout === "unified") return <div className="shell-sidebar-navigation">
    {leadingControl}
    <NavigationContent config={config} surface="applications" compact includeSettings={false} onInvoke={onInvoke} />
  </div>;
  const anonymousAccount = isAnonymousShellAccount(config.account);
  const content = surfaces.filter((surface) => {
    if (surface === "account") {
      return !transient && config.account !== null && !anonymousAccount && controller.projection.docked.account;
    }
    return transient || controller.projection.docked.applications;
  }).map(surface => <section key={surface}>
      <div className="shell-navigation__heading"><strong>{intl.formatMessage(labels[surface])}</strong></div>
      <NavigationContent compact={compact} config={config} surface={surface} onInvoke={action => action()} />
    </section>);
  if (expandedWidth !== undefined && frameWidth !== undefined) {
    return <ShellNavigationMotionFrame expandedWidth={expandedWidth} frameWidth={frameWidth}>
      {content}
    </ShellNavigationMotionFrame>;
  }
  return <div className="shell-navigation__dock-content">{content}</div>;
}

/** Shared accessory owner: desktop rail footer or mobile floating settings. */
export function ShellNavigationFooter({ config, controller, visible = true, mobile = false, entranceId = "shell-entrance", onTogglePrimaryNavigation, onPin, onInvoke = action => action() }: {
  config: ShellNavigationConfig; controller: ShellNavigationController; visible?: boolean; mobile?: boolean; entranceId?: string;
  onTogglePrimaryNavigation?: () => void; onPin?: () => void;
  onInvoke?: (action: () => void) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const { projection, state, dispatch } = controller;
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (state.peek && ((wasVisible.current && !visible) || (mobile && config.layout === "unified" && state.peek === "account"))) {
      dispatch({ type: "dismiss", surface: state.peek });
    }
    wasVisible.current = visible;
  }, [visible, mobile, config.layout, state.peek, dispatch]);
  const anonymousAccount = isAnonymousShellAccount(config.account);
  const intl = useIntl();
  const accountLabel = shellAccountEntranceLabel(config.account, intl);
  const unified = config.layout === "unified";
  const availableSurfaces = unified && mobile ? [] : surfaces.filter((surface) => surface === "applications" ? !unified : accountLabel !== null);
  // Only the managed website exposes a release feed. Mount the update
  // entrance, and with it the query runtime it reads, only there; other
  // shells must stay runnable without a query provider.
  const managedUpdateEntrance = unified && currentPlatform() === "web" && hasManagedWebUpdates()
    ? <ShellManagedUpdateEntrance selected={config.updatesActive} onInvoke={onInvoke}
      onOpenUpdates={config.onOpenUpdates} onOpenSettings={config.onOpenSettings} />
    : null;
  return <div ref={root} className={`shell-navigation__footer${unified ? " shell-navigation__footer--unified" : ""}`} aria-label="Application entrances">
    {unified ? <>
      {managedUpdateEntrance}
      <button type="button" className="shell-navigation__entrance" data-surface="settings"
        aria-label={intl.formatMessage({ id: "settings.title", defaultMessage: "Settings" })}
        title={intl.formatMessage({ id: "settings.title", defaultMessage: "Settings" })}
        aria-current={config.settingsActive ? "page" : undefined} onClick={() => {
          // Settings replaces this slot with category navigation. Keep the mobile
          // drawer available until the user chooses a destination within it.
          if (mobile) config.onOpenSettings();
          else onInvoke(config.onOpenSettings);
        }}>
        <NavigationIcon name="settings" selected={config.settingsActive} />
      </button>
    </> : null}
    {availableSurfaces.map(surface => {
      const surfaceLabel = surface === "account" ? accountLabel! : intl.formatMessage(labels.applications);
      const directSignIn = surface === "account" && anonymousAccount;
      if (directSignIn && config.account?.signIn) return <AccountSignInMenu key={surface}
        account={config.account} signIn={config.account.signIn} id={`${entranceId}-${surface}`}
        visible={visible} container={root.current} onOpenSettings={() => onInvoke(config.onOpenSettings)} />;
      return <Dialog.Root key={surface} modal={false}
      open={visible && projection.peek === surface}
      onOpenChange={open => {
        if (open && directSignIn) {
          dispatch({ type: "dismiss", surface });
          config.account?.onOpen();
        }
        else if (open && surface === "applications" && projection.primaryNavigation && onTogglePrimaryNavigation) onTogglePrimaryNavigation();
        else if (open && surface === "applications" && projection.dockAvailable && !projection.footerVisible && onPin) {
          dispatch({ type: "pin", surface, pinned: true });
          onPin();
        }
        else if (open) dispatch({ type: "toggle", surface, dockAvailable: projection.dockAvailable && projection.footerVisible });
        else dispatch({ type: "dismiss", surface });
      }}>
      <Dialog.Trigger asChild>
        <button id={`${entranceId}-${surface}`} type="button"
          className="shell-navigation__entrance" aria-label={surfaceLabel}
          data-surface={surface}
          aria-pressed={surface === "applications" ? projection.docked.applications || projection.peek === "applications" : directSignIn ? false : state.pinned[surface]}
          aria-expanded={surface === "applications" ? projection.docked.applications || projection.peek === "applications" : undefined}
          data-pinned={surface === "applications" && projection.primaryNavigation ? visible : directSignIn ? false : state.pinned[surface]}
          title={surface === "applications" && projection.primaryNavigation ? intl.formatMessage(labels.applications) : `${surfaceLabel}${!directSignIn && state.pinned[surface] ? ` · ${intl.formatMessage({ id: "navigation.pinned", defaultMessage: "Pinned" })}` : ""}`}>
          {surface === "applications" ? <NavigationIcon name="applications" selected={projection.docked.applications || projection.peek === "applications"} />
            : <><AccountLeadingVisual account={config.account} /><span className="shell-navigation__name">{surfaceLabel}</span></>}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal container={root.current}>
        <Dialog.Content className={surface === "applications" ? "shell-navigation__drawer" : "shell-navigation__peek"} aria-describedby={undefined}>
          <div className={surface === "applications" ? "shell-navigation__dock-content" : undefined}>
          <div className="shell-navigation__heading"><Dialog.Title>{intl.formatMessage(labels[surface])}</Dialog.Title></div>
          <NavigationContent compact={false} config={config} surface={surface} onInvoke={action => {
            dispatch({ type: "dismiss", surface }); onInvoke(action);
          }} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>})}
  </div>;
}

/** Self-contained managed website update entrance: the only subtree that asks
 * the release feed, so it alone needs the query runtime and the site's update
 * metadata. Other shells never mount it and never build the notice. */
function ShellManagedUpdateEntrance({ selected, onInvoke = action => action(), onOpenUpdates, onOpenSettings }: {
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
  return <button type="button"
    className="shell-navigation__entrance shell-navigation__entrance--update"
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
  </button>;
}
