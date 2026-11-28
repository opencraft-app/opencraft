import { lazy, Suspense, useMemo, useSyncExternalStore } from "react";
import { defineMessages } from "@opencraft/i18n";
import { useIntl } from "@opencraft/i18n/react";
import {
  dismissCloudRelayPairingState,
  getCloudRelayPairingState,
  getCloudRelayStandalonePortalOpen,
  openCloudRelayStandalonePortal,
  subscribeCloudRelayPairingState,
  subscribeCloudRelayStandalonePortal,
} from "../runtime/cloud-relay-banner-state";

const pairingOverlayMessages = defineMessages({
  redeeming: {
    id: "cloudRelay.pairing.redeeming",
    defaultMessage: "Connecting to remote workstation…",
  },
  pendingTitle: {
    id: "cloudRelay.pairing.pendingTitle",
    defaultMessage: "Confirm this code on your computer",
  },
  pendingDetail: {
    id: "cloudRelay.pairing.pendingDetail",
    defaultMessage: "Open Settings → Remote access on your workstation and approve this 6-character code.",
  },
  connected: {
    id: "cloudRelay.pairing.connected",
    defaultMessage: "Remote workstation connected.",
  },
  offlineTitle: {
    id: "cloudRelay.pairing.offlineTitle",
    defaultMessage: "Computer is offline or reconnecting",
  },
  switchComputer: {
    id: "remoteWelcome.hubMachinesTitle",
    defaultMessage: "My Computers",
  },
  dismiss: {
    id: "cloudRelay.pairing.dismiss",
    defaultMessage: "Dismiss",
  },
});

type ValdiBannerViewModel = {
  id: string;
  tone?: "info" | "success" | "warning" | "danger";
  title: string;
  message?: string;
  actionTitle?: string;
  dark?: boolean;
  onAction?: () => void;
  onDismiss?: () => void;
};

const LazyValdiPairingBanner = lazy(async () => {
  const mod = await import("@opencraft/design-system-web/valdi");
  function PairingBannerMount({ viewModel }: { readonly viewModel: ValdiBannerViewModel }) {
    return <mod.ValdiSurface component={mod.Banner} viewModel={viewModel} />;
  }
  return { default: PairingBannerMount };
});

export function CloudRelayPairingOverlay({ isHostless = false }: { readonly isHostless?: boolean } = {}) {
  const intl = useIntl();
  const state = useSyncExternalStore(
    subscribeCloudRelayPairingState,
    getCloudRelayPairingState,
    getCloudRelayPairingState,
  );
  const portalOpen = useSyncExternalStore(
    subscribeCloudRelayStandalonePortal,
    getCloudRelayStandalonePortalOpen,
    getCloudRelayStandalonePortalOpen,
  );

  const viewModel = useMemo((): ValdiBannerViewModel | null => {
    if (state.phase === "idle" || portalOpen || isHostless) return null;
    const dark =
      typeof document !== "undefined"
        ? document.documentElement.dataset.theme === "dark" ||
          window.matchMedia?.("(prefers-color-scheme: dark)").matches
        : true;
    if (state.phase === "redeeming") {
      return {
        id: "oc-cloud-relay-pairing-banner",
        tone: "info",
        title: intl.formatMessage(pairingOverlayMessages.redeeming),
        dark,
      };
    }
    if (state.phase === "pending_approval") {
      return {
        id: "oc-cloud-relay-pairing-banner",
        tone: "warning",
        title: `${intl.formatMessage(pairingOverlayMessages.pendingTitle)}: ${state.shortCode ?? ""}`,
        message: intl.formatMessage(pairingOverlayMessages.pendingDetail),
        actionTitle: intl.formatMessage(pairingOverlayMessages.dismiss),
        onAction: dismissCloudRelayPairingState,
        dark,
      };
    }
    if (state.phase === "connected") {
      return {
        id: "oc-cloud-relay-pairing-banner",
        tone: "success",
        title: intl.formatMessage(pairingOverlayMessages.connected),
        onDismiss: dismissCloudRelayPairingState,
        dark,
      };
    }
    if (state.phase === "offline") {
      return {
        id: "oc-cloud-relay-pairing-banner",
        tone: "info",
        title: intl.formatMessage(pairingOverlayMessages.offlineTitle),
        actionTitle: intl.formatMessage(pairingOverlayMessages.switchComputer),
        onAction: () => {
          dismissCloudRelayPairingState();
          openCloudRelayStandalonePortal();
        },
        onDismiss: dismissCloudRelayPairingState,
        dark,
      };
    }
    return {
      id: "oc-cloud-relay-pairing-banner",
      tone: "danger",
      title: state.errorMessage ?? "Pairing failed",
      actionTitle: intl.formatMessage(pairingOverlayMessages.dismiss),
      onAction: dismissCloudRelayPairingState,
      dark,
    };
  }, [intl, isHostless, portalOpen, state]);

  if (!viewModel) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="cloud-relay-pairing-overlay"
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 90,
        width: 360,
        maxWidth: "calc(100vw - 32px)",
      }}
    >
      <Suspense fallback={null}>
        <LazyValdiPairingBanner viewModel={viewModel} />
      </Suspense>
    </div>
  );
}
