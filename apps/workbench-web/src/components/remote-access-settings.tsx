import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { defineMessages } from "@opencraft/i18n";
import { useIntl } from "@opencraft/i18n/react";
import { isTouchPresentation, subscribeTouchPresentation } from "@opencraft/design-system-web/input-presentation";
import { SettingsPageHeader } from "@opencraft/extension-react";
import { requestMobileHaptic } from "../runtime/mobile-valdi-bridge";
import { encodeQrMatrix, qrMatrixToSvgDataUri } from "../utils/qr-code";

function useTouchPresentationState(): boolean {
  return useSyncExternalStore(
    (onStoreChange) =>
      typeof document === "undefined" ? () => undefined : subscribeTouchPresentation(document, onStoreChange),
    () => (typeof document === "undefined" ? false : isTouchPresentation(document)),
    () => false,
  );
}

export const remoteAccessMessages = defineMessages({
  navTitle: { id: "settings.remoteAccess.navTitle", defaultMessage: "Remote Control" },
  title: { id: "settings.remoteAccess.title", defaultMessage: "Remote Control" },
  enableTitle: { id: "settings.remoteAccess.enableTitle", defaultMessage: "Enable Remote Control" },
  enableDescription: {
    id: "settings.remoteAccess.enableDescription",
    defaultMessage: "Work with local agents from another device.",
  },
  deviceNameLabel: { id: "settings.remoteAccess.deviceNameLabel", defaultMessage: "Device name" },
  scanInlinePrefix: {
    id: "settings.remoteAccess.scanInlinePrefix",
    defaultMessage: "Scan the code to open this device in Remote Control, or ",
  },
  copyLinkInline: { id: "settings.remoteAccess.copyLinkInline", defaultMessage: "copy link" },
  copiedInline: { id: "settings.remoteAccess.copiedInline", defaultMessage: "copied" },
  scanInlineSuffix: { id: "settings.remoteAccess.scanInlineSuffix", defaultMessage: "." },
  advancedGroupTitle: { id: "settings.remoteAccess.advancedGroupTitle", defaultMessage: "Advanced & security" },
  statusConnected: { id: "settings.remoteAccess.statusConnected", defaultMessage: "Online" },
  statusConnecting: { id: "settings.remoteAccess.statusConnecting", defaultMessage: "Connecting…" },
  statusDetail: {
    id: "settings.remoteAccess.statusDetail",
    defaultMessage: "{origin} · {watchers, plural, =0 {Idle} one {# stream} other {# streams}}",
  },
  refreshRoutes: { id: "settings.remoteAccess.refreshRoutes", defaultMessage: "Refresh routes" },
  directRoutesTitle: { id: "settings.remoteAccess.directRoutesTitle", defaultMessage: "Direct LAN & Tailscale routes" },
  directRoutesEmpty: {
    id: "settings.remoteAccess.directRoutesEmpty",
    defaultMessage: "No direct local routes detected; traffic flows securely through Cloudflare Relay.",
  },
  routeKindTailscale: { id: "settings.remoteAccess.routeKindTailscale", defaultMessage: "Tailscale · Direct" },
  routeKindLan: { id: "settings.remoteAccess.routeKindLan", defaultMessage: "LAN · Direct" },
  customRelayTitle: { id: "settings.remoteAccess.customRelayTitle", defaultMessage: "Custom relay server" },
  customRelayHint: {
    id: "settings.remoteAccess.customRelayHint",
    defaultMessage: "Leave empty to use official https://relay.opencraft.app.",
  },
  approvalsGroupTitle: {
    id: "settings.remoteAccess.approvalsGroupTitle",
    defaultMessage: "Devices waiting for confirmation",
  },
  approvalsGroupDescription: {
    id: "settings.remoteAccess.approvalsGroupDescription",
    defaultMessage: "Verify the 6-character code shown on your phone or browser before approving.",
  },
  approveButton: { id: "settings.remoteAccess.approveButton", defaultMessage: "Approve" },
  copiedPairing: { id: "settings.remoteAccess.copiedPairing", defaultMessage: "Copied" },
  refreshQr: { id: "settings.remoteAccess.refreshQr", defaultMessage: "Tap QR to refresh pairing code" },
  requireApprovalTitle: {
    id: "settings.remoteAccess.requireApprovalTitle",
    defaultMessage: "Require 6-character confirmation",
  },
  requireApprovalDescription: {
    id: "settings.remoteAccess.requireApprovalDescription",
    defaultMessage: "New devices must be explicitly approved on this screen after scanning.",
  },
  shareGroupTitle: { id: "settings.remoteAccess.shareGroupTitle", defaultMessage: "Collaborator share links" },
  shareGroupDescription: {
    id: "settings.remoteAccess.shareGroupDescription",
    defaultMessage: "Invite teammates with a temporary link — zero account signup required.",
  },
  sharePermissionTitle: { id: "settings.remoteAccess.sharePermissionTitle", defaultMessage: "Access permission" },
  sharePermissionDescription: {
    id: "settings.remoteAccess.sharePermissionDescription",
    defaultMessage: "View-only links block prompt submission, command execution, and file edits.",
  },
  shareViewOnly: { id: "settings.remoteAccess.shareViewOnly", defaultMessage: "View only" },
  shareAllowExec: { id: "settings.remoteAccess.shareAllowExec", defaultMessage: "Allow execution" },
  createShare: { id: "settings.remoteAccess.createShare", defaultMessage: "Create link" },
  copyShare: { id: "settings.remoteAccess.copyShare", defaultMessage: "Copy link" },
  activeSharesEmpty: {
    id: "settings.remoteAccess.activeSharesEmpty",
    defaultMessage: "No active collaborator share links.",
  },
  revokeShare: { id: "settings.remoteAccess.revokeShare", defaultMessage: "Revoke" },
  expiresAtLabel: { id: "settings.remoteAccess.expiresAtLabel", defaultMessage: "Expires {time}" },
  hubUnclaimedTitle: { id: "settings.remoteAccess.hubUnclaimedTitle", defaultMessage: "Passkey Direct Access" },
  hubUnclaimedDesc: {
    id: "settings.remoteAccess.hubUnclaimedDesc",
    defaultMessage: "Bind a Passkey on my.opencraft.app to connect from your phone or other Macs without rescanning.",
  },
  hubClaimAction: { id: "settings.remoteAccess.hubClaimAction", defaultMessage: "Bind Passkey" },
  hubClaimedTitle: { id: "settings.remoteAccess.hubClaimedTitle", defaultMessage: "Passkey Bound" },
  hubClaimedDesc: {
    id: "settings.remoteAccess.hubClaimedDesc",
    defaultMessage: "Open my.opencraft.app on your phone or another Mac to connect directly with Touch ID or Face ID.",
  },
  hubOpenAction: { id: "settings.remoteAccess.hubOpenAction", defaultMessage: "Open my.opencraft.app" },
  hubRebindAction: { id: "settings.remoteAccess.hubRebindAction", defaultMessage: "Rebind Passkey" },
  sleepTitle: { id: "settings.remoteAccess.sleepTitle", defaultMessage: "Prevent automatic sleep" },
  sleepDescription: {
    id: "settings.remoteAccess.sleepDescription",
    defaultMessage:
      "Display can still turn off normally. Closing a laptop lid without an external display still sleeps per OS hardware rules.",
  },
  sleepModeAc: { id: "settings.remoteAccess.sleepModeAc", defaultMessage: "On Power" },
  sleepModeAlways: { id: "settings.remoteAccess.sleepModeAlways", defaultMessage: "Always" },
  sleepModeOff: { id: "settings.remoteAccess.sleepModeOff", defaultMessage: "Off" },
  sleepStatusActive: { id: "settings.remoteAccess.sleepStatusActive", defaultMessage: "Keeping system awake" },
  sleepStatusBatteryPaused: {
    id: "settings.remoteAccess.sleepStatusBatteryPaused",
    defaultMessage: "On battery · sleep allowed",
  },
  devicesGroupTitle: { id: "settings.remoteAccess.devicesGroupTitle", defaultMessage: "Authorized devices" },
  devicesGroupDescription: {
    id: "settings.remoteAccess.devicesGroupDescription",
    defaultMessage: "Phones and browsers connected via QR or Passkey. Removing a device disconnects it immediately.",
  },
  devicesEmpty: {
    id: "settings.remoteAccess.devicesEmpty",
    defaultMessage: "No external devices authorized yet.",
  },
  deviceActiveNow: { id: "settings.remoteAccess.deviceActiveNow", defaultMessage: "Connected now" },
  deviceApprovedAt: { id: "settings.remoteAccess.deviceApprovedAt", defaultMessage: "Authorized {time}" },
  revokeDevice: { id: "settings.remoteAccess.revokeDevice", defaultMessage: "Remove" },
});

interface DesktopRelayBridge {
  invoke(action: string, payload?: unknown): Promise<unknown>;
}

export function getDesktopRelayBridge(): DesktopRelayBridge | null {
  return (
    (globalThis as typeof globalThis & { opencraftDesktop?: { relay?: DesktopRelayBridge } }).opencraftDesktop?.relay ??
    null
  );
}

interface RelayStatusSnapshot {
  readonly enrolled: boolean;
  readonly connected: boolean;
  readonly activeWatchers: number;
  readonly relayOrigin: string | null;
  readonly machineId: string | null;
  readonly machineName: string;
  readonly approvalRequired: boolean;
  readonly hubClaimed?: boolean;
  readonly advertisedRoutes: ReadonlyArray<{ readonly kind: "lan" | "tailscale" | "tunnel"; readonly origin: string }>;
  readonly latestInvite?: {
    readonly httpsPairingUrl: string;
    readonly pairingUrl: string;
    readonly expiresAt: number;
    readonly approvalRequired: boolean;
  } | null;
  readonly pendingApprovals?: ReadonlyArray<{
    readonly shortCode: string;
    readonly label: string;
    readonly expiresAt: number;
  }>;
  readonly approvedDevices?: ReadonlyArray<{
    readonly thumbprint: string;
    readonly label: string;
    readonly approvedAt: number;
    readonly activeStreams: number;
  }>;
  readonly sleepProtectionMode?: "ac" | "always" | "off";
  readonly sleepBlockerActive?: boolean;
  readonly onBattery?: boolean;
  readonly activeShares?: ReadonlyArray<{
    readonly grantId: string;
    readonly allowExecution: boolean;
    readonly expiresAt: number;
    readonly shareUrl?: string;
  }>;
  readonly planTier?: "free" | "pro" | "team";
  readonly machineLimit?: number;
}

const LazyValdiRemoteAccessSettings = lazy(async () => {
  const mod = await import("@opencraft/design-system-web/valdi");
  function RemoteAccessSettingsMount({
    viewModel,
  }: {
    readonly viewModel: import("@opencraft/design-system-web/valdi").RemoteAccessSettingsProps;
  }) {
    return (
      <mod.ValdiSurface
        component={mod.RemoteAccessSettingsSurface}
        viewModel={viewModel}
        className="valdi-remote-access-settings-surface"
        data-testid="valdi-remote-access-settings-surface"
      />
    );
  }
  return { default: RemoteAccessSettingsMount };
});

export function RemoteAccessSettings({ resolvedTheme }: { readonly resolvedTheme: "light" | "dark" }) {
  const intl = useIntl();
  const touch = useTouchPresentationState();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(() => (typeof window !== "undefined" ? window.innerWidth < 680 : false));
  const [status, setStatus] = useState<RelayStatusSnapshot | null>(null);
  const [deviceNameDraft, setDeviceNameDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creatingShare, setCreatingShare] = useState(false);
  const [claimingHub, setClaimingHub] = useState(false);
  const [customRelayUrl, setCustomRelayUrl] = useState("");
  const [shareMode, setShareMode] = useState<"view" | "exec">("view");
  const [latestShareUrl, setLatestShareUrl] = useState<string | undefined>(undefined);
  const [pairingCopied, setPairingCopied] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [noticeMessage, setNoticeMessage] = useState<string | undefined>(undefined);
  const nameSaveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === "number" && width > 0) setNarrow(width < 540);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const refreshStatus = useCallback(async (ensureInvite = false) => {
    const bridge = getDesktopRelayBridge();
    if (!bridge) return;
    try {
      const next = (await bridge.invoke("status", { ensureInvite })) as RelayStatusSnapshot;
      setStatus(next);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refreshStatus(true);
    const timer = window.setInterval(() => {
      void refreshStatus(false);
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  const commitDeviceName = useCallback(async (rawName: string) => {
    const bridge = getDesktopRelayBridge();
    if (!bridge) return;
    try {
      const next = (await bridge.invoke("set-device-name", { displayName: rawName })) as RelayStatusSnapshot;
      setStatus(next);
      setDeviceNameDraft(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const handleChangeDeviceName = useCallback(
    (value: string) => {
      setDeviceNameDraft(value);
      if (nameSaveTimerRef.current !== null) window.clearTimeout(nameSaveTimerRef.current);
      nameSaveTimerRef.current = window.setTimeout(() => {
        void commitDeviceName(value);
      }, 900);
    },
    [commitDeviceName],
  );

  const handleSubmitDeviceName = useCallback(
    (value: string) => {
      if (nameSaveTimerRef.current !== null) {
        window.clearTimeout(nameSaveTimerRef.current);
        nameSaveTimerRef.current = null;
      }
      void commitDeviceName(value);
    },
    [commitDeviceName],
  );

  const handleToggleEnabled = useCallback(
    async (next: boolean, relayOriginOverride: string) => {
      const bridge = getDesktopRelayBridge();
      if (!bridge) return;
      setBusy(true);
      setErrorMessage(undefined);
      try {
        if (next) {
          const enrolled = (await bridge.invoke("enable", {
            ...(relayOriginOverride.trim() ? { relayOrigin: relayOriginOverride.trim() } : {}),
            ...(deviceNameDraft?.trim() ? { displayName: deviceNameDraft.trim() } : {}),
          })) as RelayStatusSnapshot;
          setStatus(enrolled);
        } else {
          const disabled = (await bridge.invoke("disable")) as RelayStatusSnapshot;
          setStatus(disabled);
          setLatestShareUrl(undefined);
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [deviceNameDraft],
  );

  const handleRefreshRoutes = useCallback(async () => {
    const bridge = getDesktopRelayBridge();
    if (!bridge) return;
    setBusy(true);
    setErrorMessage(undefined);
    try {
      const next = (await bridge.invoke("refresh-routes")) as RelayStatusSnapshot;
      setStatus(next);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleRefreshQr = useCallback(async () => {
    const bridge = getDesktopRelayBridge();
    if (!bridge) return;
    setBusy(true);
    setErrorMessage(undefined);
    try {
      await bridge.invoke("pair-invite", { approvalRequired: status?.approvalRequired === true });
      await refreshStatus(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [refreshStatus, status?.approvalRequired]);

  const handleChangeRequireApproval = useCallback(
    async (next: boolean) => {
      const bridge = getDesktopRelayBridge();
      if (!bridge) return;
      setBusy(true);
      setErrorMessage(undefined);
      try {
        await bridge.invoke("pair-invite", { approvalRequired: next });
        await refreshStatus(false);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [refreshStatus],
  );

  const handleApproveDevice = useCallback(async (shortCode: string) => {
    const bridge = getDesktopRelayBridge();
    if (!bridge) return;
    setBusy(true);
    setErrorMessage(undefined);
    try {
      const next = (await bridge.invoke("approve-device", { shortCode })) as RelayStatusSnapshot;
      setStatus(next);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleRevokeDevice = useCallback(async (thumbprint: string) => {
    const bridge = getDesktopRelayBridge();
    if (!bridge) return;
    setBusy(true);
    setErrorMessage(undefined);
    try {
      const next = (await bridge.invoke("revoke-device", { thumbprint })) as RelayStatusSnapshot;
      setStatus(next);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleChangeSleepProtection = useCallback(async (mode: "ac" | "always" | "off") => {
    const bridge = getDesktopRelayBridge();
    if (!bridge) return;
    setErrorMessage(undefined);
    try {
      const next = (await bridge.invoke("set-sleep-protection", { mode })) as RelayStatusSnapshot;
      setStatus(next);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const handleCreateShare = useCallback(async () => {
    const bridge = getDesktopRelayBridge();
    if (!bridge) return;
    setCreatingShare(true);
    setErrorMessage(undefined);
    try {
      const created = (await bridge.invoke("create-share", {
        allowExecution: shareMode === "exec",
      })) as { shareUrl: string };
      setLatestShareUrl(created.shareUrl);
      await navigator.clipboard?.writeText(created.shareUrl).catch(() => undefined);
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 2_200);
      await refreshStatus(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingShare(false);
    }
  }, [refreshStatus, shareMode]);

  const handleRevokeShare = useCallback(async (grantId: string) => {
    const bridge = getDesktopRelayBridge();
    if (!bridge) return;
    setBusy(true);
    setErrorMessage(undefined);
    try {
      const next = (await bridge.invoke("revoke-share", { grantId })) as RelayStatusSnapshot;
      setStatus(next);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleHubAction = useCallback(async () => {
    const bridge = getDesktopRelayBridge();
    if (!bridge) return;
    setClaimingHub(true);
    setErrorMessage(undefined);
    try {
      if (status?.hubClaimed) {
        await bridge.invoke("open-hub");
      } else {
        await bridge.invoke("open-claim-url");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setClaimingHub(false);
    }
  }, [status?.hubClaimed]);

  const handleHubRebindAction = useCallback(async () => {
    const bridge = getDesktopRelayBridge();
    if (!bridge) return;
    setClaimingHub(true);
    setErrorMessage(undefined);
    try {
      await bridge.invoke("open-claim-url");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setClaimingHub(false);
    }
  }, []);

  const pairingUrl = status?.latestInvite?.httpsPairingUrl ?? "";
  const isDark = resolvedTheme === "dark";
  const qrArtifacts = useMemo(() => {
    if (!pairingUrl) return { matrix: undefined, svgUri: undefined };
    try {
      const matrix = encodeQrMatrix(pairingUrl);
      return {
        matrix,
        svgUri: qrMatrixToSvgDataUri(matrix, {
          darkColor: isDark ? "#f5f5f7" : "#141416",
          lightColor: isDark ? "#111113" : "#ffffff",
          margin: 1,
        }),
      };
    } catch {
      return { matrix: undefined, svgUri: undefined };
    }
  }, [isDark, pairingUrl]);

  const handleCopyPairingUrl = useCallback(() => {
    if (!pairingUrl) return;
    void navigator.clipboard?.writeText(pairingUrl).then(() => {
      setPairingCopied(true);
      window.setTimeout(() => setPairingCopied(false), 2_200);
    });
  }, [pairingUrl]);

  const handleCopyShareUrl = useCallback((url: string) => {
    void navigator.clipboard?.writeText(url).then(() => {
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 2_200);
    });
  }, []);

  const handleHaptic = useCallback((style: string) => {
    requestMobileHaptic(style === "warning" ? "warning" : style === "light" ? "light" : "selection");
  }, []);

  const title = intl.formatMessage(remoteAccessMessages.title);
  const displayedDeviceName = deviceNameDraft ?? status?.machineName ?? "";

  const viewModel = useMemo(
    (): import("@opencraft/design-system-web/valdi").RemoteAccessSettingsProps => ({
      dark: isDark,
      touch,
      narrow,
      title,
      errorMessage,
      noticeMessage,
      enableTitle: intl.formatMessage(remoteAccessMessages.enableTitle),
      enableDescription: intl.formatMessage(remoteAccessMessages.enableDescription),
      enabled: Boolean(status?.enrolled),
      busy,
      deviceNameLabel: intl.formatMessage(remoteAccessMessages.deviceNameLabel),
      deviceNamePlaceholder: "mbp-local",
      deviceName: displayedDeviceName,
      scanInlinePrefix: intl.formatMessage(remoteAccessMessages.scanInlinePrefix),
      copyLinkInlineLabel: intl.formatMessage(remoteAccessMessages.copyLinkInline),
      copiedInlineLabel: intl.formatMessage(remoteAccessMessages.copiedInline),
      scanInlineSuffix: intl.formatMessage(remoteAccessMessages.scanInlineSuffix),
      pairingUrl,
      qrSvgDataUri: qrArtifacts.svgUri,
      qrMatrix: qrArtifacts.matrix,
      pairingCopied,
      refreshQrLabel: intl.formatMessage(remoteAccessMessages.refreshQr),
      sleepProtectionTitle: intl.formatMessage(remoteAccessMessages.sleepTitle),
      sleepProtectionDescription: intl.formatMessage(remoteAccessMessages.sleepDescription),
      sleepProtectionStatusLabel:
        status?.sleepProtectionMode === "off"
          ? undefined
          : status?.sleepBlockerActive
            ? intl.formatMessage(remoteAccessMessages.sleepStatusActive)
            : status?.sleepProtectionMode === "ac" && status?.onBattery
              ? intl.formatMessage(remoteAccessMessages.sleepStatusBatteryPaused)
              : undefined,
      sleepProtectionActive: Boolean(status?.sleepBlockerActive),
      sleepProtectionMode: status?.sleepProtectionMode ?? "ac",
      sleepModeAcLabel: intl.formatMessage(remoteAccessMessages.sleepModeAc),
      sleepModeAlwaysLabel: intl.formatMessage(remoteAccessMessages.sleepModeAlways),
      sleepModeOffLabel: intl.formatMessage(remoteAccessMessages.sleepModeOff),
      advancedGroupTitle: intl.formatMessage(remoteAccessMessages.advancedGroupTitle),
      statusTitle: status?.connected
        ? intl.formatMessage(remoteAccessMessages.statusConnected)
        : intl.formatMessage(remoteAccessMessages.statusConnecting),
      statusDetail: intl.formatMessage(remoteAccessMessages.statusDetail, {
        origin: status?.relayOrigin ?? "https://relay.opencraft.app",
        watchers: status?.activeWatchers ?? 0,
      }),
      connected: Boolean(status?.connected),
      refreshRoutesLabel: intl.formatMessage(remoteAccessMessages.refreshRoutes),
      directRoutesTitle: intl.formatMessage(remoteAccessMessages.directRoutesTitle),
      directRoutesEmpty: intl.formatMessage(remoteAccessMessages.directRoutesEmpty),
      directRoutes: (status?.advertisedRoutes ?? []).map((route, idx) => ({
        id: `${route.kind}-${idx}-${route.origin}`,
        kindLabel:
          route.kind === "tailscale"
            ? intl.formatMessage(remoteAccessMessages.routeKindTailscale)
            : intl.formatMessage(remoteAccessMessages.routeKindLan),
        url: route.origin,
      })),
      customRelayTitle: intl.formatMessage(remoteAccessMessages.customRelayTitle),
      customRelayPlaceholder: "https://relay.opencraft.app",
      customRelayHint: intl.formatMessage(remoteAccessMessages.customRelayHint),
      customRelayUrl,
      requireApprovalTitle: intl.formatMessage(remoteAccessMessages.requireApprovalTitle),
      requireApprovalDescription: intl.formatMessage(remoteAccessMessages.requireApprovalDescription),
      requireApproval: Boolean(status?.approvalRequired),
      hubClaimed: Boolean(status?.hubClaimed),
      hubTitle: status?.hubClaimed
        ? intl.formatMessage(remoteAccessMessages.hubClaimedTitle)
        : intl.formatMessage(remoteAccessMessages.hubUnclaimedTitle),
      hubDescription: status?.hubClaimed
        ? intl.formatMessage(remoteAccessMessages.hubClaimedDesc)
        : intl.formatMessage(remoteAccessMessages.hubUnclaimedDesc),
      hubActionLabel: status?.hubClaimed
        ? intl.formatMessage(remoteAccessMessages.hubOpenAction)
        : intl.formatMessage(remoteAccessMessages.hubClaimAction),
      hubRebindActionLabel: status?.hubClaimed ? intl.formatMessage(remoteAccessMessages.hubRebindAction) : undefined,
      claimingHub,
      approvalsGroupTitle: intl.formatMessage(remoteAccessMessages.approvalsGroupTitle),
      approvalsGroupDescription: intl.formatMessage(remoteAccessMessages.approvalsGroupDescription),
      approveButtonLabel: intl.formatMessage(remoteAccessMessages.approveButton),
      pendingApprovals: (status?.pendingApprovals ?? []).map((item) => ({
        shortCode: item.shortCode,
        label: item.label,
        expiresLabel: intl.formatMessage(remoteAccessMessages.expiresAtLabel, {
          time: new Date(item.expiresAt).toLocaleTimeString(),
        }),
      })),
      devicesGroupTitle: intl.formatMessage(remoteAccessMessages.devicesGroupTitle),
      devicesGroupDescription: intl.formatMessage(remoteAccessMessages.devicesGroupDescription),
      devicesEmptyText: intl.formatMessage(remoteAccessMessages.devicesEmpty),
      revokeDeviceLabel: intl.formatMessage(remoteAccessMessages.revokeDevice),
      approvedDevices: (status?.approvedDevices ?? []).map((dev) => ({
        thumbprint: dev.thumbprint,
        label: dev.label,
        active: dev.activeStreams > 0,
        detailLabel:
          dev.activeStreams > 0
            ? intl.formatMessage(remoteAccessMessages.deviceActiveNow)
            : intl.formatMessage(remoteAccessMessages.deviceApprovedAt, {
                time: new Date(dev.approvedAt).toLocaleString(),
              }),
      })),
      shareGroupTitle: intl.formatMessage(remoteAccessMessages.shareGroupTitle),
      shareGroupDescription: intl.formatMessage(remoteAccessMessages.shareGroupDescription),
      sharePermissionTitle: intl.formatMessage(remoteAccessMessages.sharePermissionTitle),
      sharePermissionDescription: intl.formatMessage(remoteAccessMessages.sharePermissionDescription),
      shareViewOnlyLabel: intl.formatMessage(remoteAccessMessages.shareViewOnly),
      shareAllowExecLabel: intl.formatMessage(remoteAccessMessages.shareAllowExec),
      shareMode,
      createShareLabel: intl.formatMessage(remoteAccessMessages.createShare),
      creatingShare,
      latestShareUrl,
      copyShareLabel: intl.formatMessage(remoteAccessMessages.copyShare),
      copiedShareLabel: intl.formatMessage(remoteAccessMessages.copiedPairing),
      shareCopied,
      activeSharesEmpty: intl.formatMessage(remoteAccessMessages.activeSharesEmpty),
      revokeShareLabel: intl.formatMessage(remoteAccessMessages.revokeShare),
      activeShares: (status?.activeShares ?? []).map((item) => ({
        grantId: item.grantId,
        permissionLabel: item.allowExecution
          ? intl.formatMessage(remoteAccessMessages.shareAllowExec)
          : intl.formatMessage(remoteAccessMessages.shareViewOnly),
        expiresLabel: intl.formatMessage(remoteAccessMessages.expiresAtLabel, {
          time: new Date(item.expiresAt).toLocaleString(),
        }),
        shareUrl: item.shareUrl,
      })),
      onToggleEnabled: (next: boolean, relayOriginOverride: string) => {
        void handleToggleEnabled(next, relayOriginOverride);
      },
      onChangeDeviceName: handleChangeDeviceName,
      onSubmitDeviceName: handleSubmitDeviceName,
      onChangeCustomRelayUrl: setCustomRelayUrl,
      onRefreshRoutes: () => {
        void handleRefreshRoutes();
      },
      onCopyPairingUrl: handleCopyPairingUrl,
      onRefreshQr: () => {
        void handleRefreshQr();
      },
      onChangeSleepProtectionMode: (mode: "ac" | "always" | "off") => {
        void handleChangeSleepProtection(mode);
      },
      onChangeRequireApproval: (next: boolean) => {
        void handleChangeRequireApproval(next);
      },
      onApproveDevice: (shortCode: string) => {
        void handleApproveDevice(shortCode);
      },
      onRevokeDevice: (thumbprint: string) => {
        void handleRevokeDevice(thumbprint);
      },
      onChangeShareMode: setShareMode,
      onCreateShare: () => {
        void handleCreateShare();
      },
      onCopyShareUrl: handleCopyShareUrl,
      onRevokeShare: (grantId: string) => {
        void handleRevokeShare(grantId);
      },
      onHubAction: () => {
        void handleHubAction();
      },
      onHubRebindAction: () => {
        void handleHubRebindAction();
      },
      onDismissNotice: () => setNoticeMessage(undefined),
      onHaptic: handleHaptic,
    }),
    [
      busy,
      claimingHub,
      creatingShare,
      customRelayUrl,
      displayedDeviceName,
      errorMessage,
      handleApproveDevice,
      handleChangeDeviceName,
      handleChangeRequireApproval,
      handleChangeSleepProtection,
      handleCopyPairingUrl,
      handleCopyShareUrl,
      handleCreateShare,
      handleHaptic,
      handleHubAction,
      handleHubRebindAction,
      handleRefreshQr,
      handleRefreshRoutes,
      handleRevokeDevice,
      handleSubmitDeviceName,
      handleToggleEnabled,
      intl,
      isDark,
      latestShareUrl,
      narrow,
      noticeMessage,
      pairingCopied,
      pairingUrl,
      qrArtifacts.matrix,
      qrArtifacts.svgUri,
      shareCopied,
      shareMode,
      status,
      title,
      touch,
    ],
  );

  return (
    <div ref={containerRef} className="valdi-settings-route-container">
      <Suspense fallback={<SettingsPageHeader title={title} />}>
        <LazyValdiRemoteAccessSettings viewModel={viewModel} />
      </Suspense>
    </div>
  );
}
