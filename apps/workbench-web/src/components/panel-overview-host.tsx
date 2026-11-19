import { useWorkbenchPanelRuntime } from "../runtime/panel-runtime-context";
import { panelViewKey } from "./retained-view-preview";
import { useShellPresentation } from "./shell-presentation";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { SafeLayout } from "@opencraft/design-system-web/safe-layout";
import { ModalSurface } from "./modal/modal-surface";
import { PanelTabOverview } from "./panel-tab-overview";
import { usePanelNavigation } from "./panel-navigation";
import { usePanelOverviewPresentation } from "./panel-overview-presentation";

/** The one Shell request is rendered against the existing panel navigation owner. */
export function PanelOverviewHost({ enabled }: { enabled: boolean }) {
  const navigation = usePanelNavigation()!;
  const overview = usePanelOverviewPresentation();
  const { panels } = useWorkbenchPanelRuntime();
  const tabs = useMemo(
    () => ({
      subscribe: (listener: () => void) => panels.subscribeOwner(navigation.ownerId, listener),
      getCount: () => panels.getOwnerSnapshot(navigation.ownerId).right.tabs.length,
    }),
    [panels, navigation.ownerId],
  );
  const intl = useIntl();
  const shell = useShellPresentation();
  const dismissMotion = useRef<(() => void) | null>(null);
  const registerDismiss = useCallback((dismiss: () => void) => {
    dismissMotion.current = dismiss;
    return () => {
      if (dismissMotion.current === dismiss) dismissMotion.current = null;
    };
  }, []);
  const token = useMemo(() => Symbol("panel-overview"), [navigation.ownerId]);
  const publish = overview?.publish,
    release = overview?.release;
  useLayoutEffect(() => {
    if (enabled)
      publish?.({
        token,
        ownerId: navigation.ownerId,
        tabs,
        activeViewKey: navigation.activeTabId ? panelViewKey(navigation.ownerId, navigation.activeTabId) : null,
      });
  }, [enabled, publish, token, navigation.ownerId, tabs, navigation.activeTabId]);
  useLayoutEffect(
    () => () => {
      release?.(token);
    },
    [enabled, release, token],
  );
  if (!enabled || !overview?.open || overview.destination?.token !== token) return null;
  return (
    <ModalSurface
      label={intl.formatMessage({ id: "panel.tabs", defaultMessage: "Tabs" })}
      dimBackground={shell?.overviewPresentation === "contained"}
      className="panel-mobile-sheet panel-mobile-sheet--tabs"
      presentation={shell?.overviewPresentation === "contained" ? "adaptive-sheet" : "fullscreen"}
      returnFocus={() =>
        Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-testid="composer-panel-toggle"], .panel-mobile-dock__tabs, .panel-toolbar-overview',
          ),
        ).find(
          (node) =>
            !node.closest('[inert], [aria-hidden="true"]') &&
            node.getBoundingClientRect().width > 0 &&
            node.getBoundingClientRect().height > 0,
        ) ?? null
      }
      deferReturnFocus={overview.returnFocus}
      initialFocus="surface"
      showCloseButton={false}
      onDismiss={() => (dismissMotion.current ?? overview.dismiss)()}
    >
      <SafeLayout
        className="panel-overview-host__body"
        edges={shell?.overviewPresentation === "contained" ? [] : ["top", "bottom"]}
      >
        <PanelTabOverview
          key={navigation.ownerId}
          onDismiss={overview.dismiss}
          origin={overview.origin}
          registerDismiss={registerDismiss}
        />
      </SafeLayout>
    </ModalSurface>
  );
}
