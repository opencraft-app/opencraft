import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { defineMessages } from "@opencraft/i18n";
import { useIntl } from "@opencraft/i18n/react";
import { isTouchPresentation, subscribeTouchPresentation } from "@opencraft/design-system-web/input-presentation";
import { remoteServerOrigin } from "@opencraft/plugin-local-account/connections";
import type { HostConnectionProfileStore } from "@opencraft/workbench-runtime";
import { useAppearanceTheme } from "../appearance-theme";
import {
  dismissCloudRelayPairingState,
  getCloudRelayPairingState,
  subscribeCloudRelayPairingState,
} from "../runtime/cloud-relay-banner-state";
import type {
  ParsedClaimTicketPreview,
  PersonalHubOverview,
  StoredCloudRelaySession,
  StoredPersonalHubSession,
} from "../runtime/cloud-relay-client";
import { requestMobileHaptic } from "../runtime/mobile-valdi-bridge";
import { setLocalPreference } from "../runtime/workbench-application-services";
import "./desktop-welcome.scss";

function useTouchPresentationState(): boolean {
  return useSyncExternalStore(
    (onStoreChange) =>
      typeof document === "undefined" ? () => undefined : subscribeTouchPresentation(document, onStoreChange),
    () => (typeof document === "undefined" ? false : isTouchPresentation(document)),
    () => false,
  );
}

function hasExplicitStoredThemePreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.localStorage.getItem("opencraft.appearance-theme") !== null ||
      window.localStorage.getItem("vela.appearance-theme") !== null
    );
  } catch {
    return false;
  }
}

function useSystemPrefersDark(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", onStoreChange);
      return () => mq.removeEventListener("change", onStoreChange);
    },
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)").matches : false),
    () => false,
  );
}

const remoteWelcomeMessages = defineMessages({
  title: { id: "remoteWelcome.title", defaultMessage: "Connect Your Computer" },
  subtitle: {
    id: "remoteWelcome.subtitle",
    defaultMessage:
      "Agents run locally on your Mac or PC. Open Settings → Remote Control on your computer to scan or bind a Passkey.",
  },
  hubMachinesTitle: { id: "remoteWelcome.hubMachinesTitle", defaultMessage: "My Computers" },
  hubMachineCount: {
    id: "remoteWelcome.hubMachineCount",
    defaultMessage: "{count, plural, one {# device} other {# devices}}",
  },
  hubAddDeviceHint: {
    id: "remoteWelcome.hubAddDeviceHint",
    defaultMessage: "Bind another computer in Settings → Remote Control",
  },
  hubPasteTempLink: { id: "remoteWelcome.hubPasteTempLink", defaultMessage: "Paste link" },
  hubSignIn: { id: "remoteWelcome.hubSignIn", defaultMessage: "Sign in with Passkey" },
  hubRefresh: { id: "remoteWelcome.hubRefresh", defaultMessage: "Refresh" },
  hubSignOut: { id: "remoteWelcome.hubSignOut", defaultMessage: "Sign out" },
  disconnectBrowser: { id: "remoteWelcome.disconnectBrowser", defaultMessage: "Disconnect" },
  backToWorkspace: { id: "remoteWelcome.backToWorkspace", defaultMessage: "Back to Workspace" },
  hubEmptyMachines: {
    id: "remoteWelcome.hubEmptyMachines",
    defaultMessage: "No computers bound yet. Open OpenCraft Desktop → Settings → Remote Control → Bind Passkey.",
  },
  hubMachineOnline: { id: "remoteWelcome.hubMachineOnline", defaultMessage: "Online" },
  hubMachineOffline: { id: "remoteWelcome.hubMachineOffline", defaultMessage: "Offline" },
  hubMachinePaired: { id: "remoteWelcome.hubMachinePaired", defaultMessage: "Paired" },
  hubOpenWorkspace: { id: "remoteWelcome.hubOpenWorkspace", defaultMessage: "Open Workspace" },
  passkeyNotFoundTitle: {
    id: "remoteWelcome.passkeyNotFoundTitle",
    defaultMessage: "No Passkey found on this device",
  },
  passkeyNotFoundDesc: {
    id: "remoteWelcome.passkeyNotFoundDesc",
    defaultMessage:
      "First time here? On your computer, open OpenCraft → Settings → Remote Control to scan the QR code or bind a Passkey.",
  },
  threadRunning: { id: "remoteWelcome.threadRunning", defaultMessage: "Running" },
  threadWaiting: { id: "remoteWelcome.threadWaiting", defaultMessage: "Needs confirmation" },
  threadFailed: { id: "remoteWelcome.threadFailed", defaultMessage: "Failed" },
  threadIdle: { id: "remoteWelcome.threadIdle", defaultMessage: "Idle" },
  claimBannerTitle: { id: "remoteWelcome.claimBannerTitle", defaultMessage: "Bind Passkey" },
  claimBannerDesc: {
    id: "remoteWelcome.claimBannerDesc",
    defaultMessage:
      "Open my.opencraft.app on your phone or another Mac to connect to “{name}” with Touch ID or Face ID — no QR code needed.",
  },
  claimNewPasskey: { id: "remoteWelcome.claimNewPasskey", defaultMessage: "Create Passkey & Bind" },
  claimExistingPasskey: { id: "remoteWelcome.claimExistingPasskey", defaultMessage: "Add to Existing Passkey" },
  claimConfirmCurrent: { id: "remoteWelcome.claimConfirmCurrent", defaultMessage: "Bind to Current Passkey" },
  claimPrivacyHint: {
    id: "remoteWelcome.claimPrivacyHint",
    defaultMessage: "No email or password · Syncs device names & recent thread titles only",
  },
  cancelClaim: { id: "remoteWelcome.cancelClaim", defaultMessage: "Cancel" },
  orPasteLink: { id: "remoteWelcome.orPasteLink", defaultMessage: "or paste a link" },
  linkLabel: { id: "remoteWelcome.linkLabel", defaultMessage: "Pairing or collaborator share link" },
  linkPlaceholder: { id: "remoteWelcome.linkPlaceholder", defaultMessage: "Paste pairing or share link…" },
  connectLink: { id: "remoteWelcome.connectLink", defaultMessage: "Connect" },
  connecting: { id: "remoteWelcome.connecting", defaultMessage: "Connecting…" },
  downloadAction: { id: "remoteWelcome.downloadAction", defaultMessage: "Download Desktop App" },
  invalidLink: {
    id: "remoteWelcome.invalidLink",
    defaultMessage: "Paste a valid OpenCraft pairing link (/pair?m=...#code=...) or share link (/s/...).",
  },
  pendingTitle: { id: "remoteWelcome.pendingTitle", defaultMessage: "Confirm this code on your computer" },
  pendingDetail: {
    id: "remoteWelcome.pendingDetail",
    defaultMessage: "Approve this 6-character code in Settings → Remote Control to open your workspace.",
  },
  serverDisclosure: { id: "remoteWelcome.serverDisclosure", defaultMessage: "Self-hosted server" },
  serverAddress: { id: "remoteWelcome.serverAddress", defaultMessage: "Server address" },
  connectServer: { id: "remoteWelcome.connectServer", defaultMessage: "Open" },
  invalidServer: {
    id: "remoteWelcome.invalidServer",
    defaultMessage: "Enter an HTTPS server origin without a path (for example, https://workbench.example.com).",
  },
  clear: { id: "settings.remoteAccess.clearInput", defaultMessage: "Clear" },
});

const LazyValdiRemoteWelcome = lazy(async () => {
  const mod = await import("@opencraft/design-system-web/valdi");
  function RemoteWelcomeMount({
    viewModel,
  }: {
    readonly viewModel: import("@opencraft/design-system-web/valdi").RemoteWorkbenchWelcomeProps;
  }) {
    return (
      <mod.ValdiSurface
        component={mod.RemoteWorkbenchWelcomeSurface}
        viewModel={viewModel}
        className="valdi-remote-access-settings-surface remote-welcome-standalone-surface"
        data-testid="valdi-remote-workbench-welcome-surface"
      />
    );
  }
  return { default: RemoteWelcomeMount };
});

export function RemoteWorkbenchWelcome({
  hostProfiles,
  hasConnectedHost = false,
  onClosePortal,
}: {
  readonly hostProfiles: HostConnectionProfileStore;
  readonly hasConnectedHost?: boolean;
  readonly onClosePortal?: () => void;
}) {
  const intl = useIntl();
  const appearance = useAppearanceTheme();
  const systemPrefersDark = useSystemPrefersDark();
  const effectiveDark = hasExplicitStoredThemePreference() ? appearance.resolvedTheme === "dark" : systemPrefersDark;
  const touch = useTouchPresentationState();
  const pairingState = useSyncExternalStore(
    subscribeCloudRelayPairingState,
    getCloudRelayPairingState,
    getCloudRelayPairingState,
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(() => (typeof window !== "undefined" ? window.innerWidth < 500 : false));
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [hubSession, setHubSession] = useState<StoredPersonalHubSession | null>(null);
  const [hubOverview, setHubOverview] = useState<PersonalHubOverview | null>(null);
  const [localPairedSessions, setLocalPairedSessions] = useState<readonly StoredCloudRelaySession[]>([]);
  const [claimPreview, setClaimPreview] = useState<ParsedClaimTicketPreview | null>(null);
  const [linkValue, setLinkValue] = useState("");
  const [connectingLink, setConnectingLink] = useState(false);
  const [serverValue, setServerValue] = useState("");
  const [connectingServer, setConnectingServer] = useState(false);
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const [passkeyGuideVisible, setPasskeyGuideVisible] = useState(false);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === "number" && width > 0) setNarrow(width < 480);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const enterSelectedHost = useCallback(
    (hostId: string) => {
      setLocalPreference("opencraft.active-host-id", hostId);
      try {
        window.sessionStorage.setItem("opencraft.hub-entered-session", "1");
      } catch {}
      onClosePortal?.();
      window.location.reload();
    },
    [onClosePortal],
  );

  const refreshHubAndMaybeEnter = useCallback(
    async (session: StoredPersonalHubSession, autoEnterOnline: boolean, preferredMachineId?: string) => {
      const mod = await import("../runtime/cloud-relay-client");
      const overview = await mod.fetchPersonalHubOverview(session);
      if (!overview) {
        setHubSession(null);
        setHubOverview(null);
        return;
      }
      setHubOverview(overview);
      const onlineCount = overview.machines.filter((m) => m.online).length;
      if (autoEnterOnline && !hasConnectedHost && (preferredMachineId || onlineCount === 1)) {
        const chosen = await mod.activateHubMachineInWorkbench(hostProfiles, session, overview, preferredMachineId);
        if (chosen) {
          enterSelectedHost(chosen);
        }
      } else if (preferredMachineId && hasConnectedHost) {
        const chosen = await mod.activateHubMachineInWorkbench(hostProfiles, session, overview, preferredMachineId);
        if (chosen) {
          enterSelectedHost(chosen);
        }
      }
    },
    [enterSelectedHost, hasConnectedHost, hostProfiles],
  );

  useEffect(() => {
    let cancelled = false;
    void import("../runtime/cloud-relay-client").then(async (mod) => {
      if (cancelled) return;
      setPasskeySupported(mod.isWebAuthnPasskeySupported());
      setLocalPairedSessions(mod.listStoredCloudRelaySessions());
      let rawClaimHref = window.location.href;
      try {
        const stashed = window.sessionStorage.getItem("opencraft.pending-claim-href");
        if (stashed) {
          rawClaimHref = stashed;
          window.sessionStorage.removeItem("opencraft.pending-claim-href");
        }
      } catch {}
      const claim = mod.parseClaimTicketFromUrl(rawClaimHref);
      if (claim) {
        setClaimPreview(claim);
        try {
          window.history.replaceState(null, "", "/");
        } catch {}
      }
      const existingHub = mod.readStoredPersonalHubSession();
      if (existingHub) {
        setHubSession(existingHub);
        await refreshHubAndMaybeEnter(existingHub, !claim && !hasConnectedHost).catch(() => undefined);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [hasConnectedHost, refreshHubAndMaybeEnter]);

  const executeClaimAndRefresh = useCallback(
    async (session: StoredPersonalHubSession, claim: ParsedClaimTicketPreview | null) => {
      const mod = await import("../runtime/cloud-relay-client");
      let claimedId: string | undefined;
      if (claim) {
        const claimed = await mod.claimMachineIntoPersonalHub(session, claim.rawTicket);
        claimedId = claimed.machineId;
        setClaimPreview(null);
      }
      await refreshHubAndMaybeEnter(session, true, claimedId);
    },
    [refreshHubAndMaybeEnter],
  );

  const handlePasskeySignIn = useCallback(async () => {
    if (passkeyBusy) return;
    setPasskeyBusy(true);
    setLocalError(undefined);
    setPasskeyGuideVisible(false);
    try {
      const mod = await import("../runtime/cloud-relay-client");
      const relayOrigin = claimPreview?.relayOrigin ?? "https://relay.opencraft.app";
      const session = await mod.signInPersonalHubWithPasskey(relayOrigin);
      setHubSession(session);
      await executeClaimAndRefresh(session, claimPreview);
    } catch (err) {
      const mod = await import("../runtime/cloud-relay-client");
      if (mod.isPasskeyUserCancelledOrNotFound(err)) {
        if (!claimPreview) {
          setPasskeyGuideVisible(true);
        }
      } else {
        setLocalError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setPasskeyBusy(false);
    }
  }, [claimPreview, executeClaimAndRefresh, passkeyBusy]);

  const handlePasskeyCreate = useCallback(async () => {
    if (passkeyBusy) return;
    setPasskeyBusy(true);
    setLocalError(undefined);
    setPasskeyGuideVisible(false);
    try {
      const mod = await import("../runtime/cloud-relay-client");
      const relayOrigin = claimPreview?.relayOrigin ?? "https://relay.opencraft.app";
      const session = await mod.createPersonalHubWithPasskey(relayOrigin, claimPreview?.displayName);
      setHubSession(session);
      await executeClaimAndRefresh(session, claimPreview);
    } catch (err) {
      const mod = await import("../runtime/cloud-relay-client");
      if (!mod.isPasskeyUserCancelledOrNotFound(err)) {
        setLocalError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setPasskeyBusy(false);
    }
  }, [claimPreview, executeClaimAndRefresh, passkeyBusy]);

  const handleConfirmClaimCurrentHub = useCallback(async () => {
    if (!hubSession || !claimPreview || passkeyBusy) return;
    setPasskeyBusy(true);
    setLocalError(undefined);
    try {
      await executeClaimAndRefresh(hubSession, claimPreview);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setPasskeyBusy(false);
    }
  }, [claimPreview, executeClaimAndRefresh, hubSession, passkeyBusy]);

  const handleHubRefresh = useCallback(async () => {
    if (!hubSession || passkeyBusy) return;
    setPasskeyBusy(true);
    setLocalError(undefined);
    try {
      await refreshHubAndMaybeEnter(hubSession, false);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setPasskeyBusy(false);
    }
  }, [hubSession, passkeyBusy, refreshHubAndMaybeEnter]);

  const handleHubSignOut = useCallback(async () => {
    const mod = await import("../runtime/cloud-relay-client");
    await mod.disconnectAllCloudRelaySessions(hostProfiles);
    setHubSession(null);
    setHubOverview(null);
    setLocalPairedSessions([]);
    if (hasConnectedHost) {
      onClosePortal?.();
      window.location.reload();
    }
  }, [hasConnectedHost, hostProfiles, onClosePortal]);

  const handleConnectHubMachine = useCallback(
    async (machineId: string) => {
      const mod = await import("../runtime/cloud-relay-client");
      if (hubSession && hubOverview && hubOverview.machines.some((m) => m.machineId === machineId)) {
        const chosen = await mod.activateHubMachineInWorkbench(hostProfiles, hubSession, hubOverview, machineId);
        if (chosen) {
          enterSelectedHost(chosen);
        }
        return;
      }
      const paired = localPairedSessions.find((s) => s.machineId === machineId || s.sessionKey === machineId);
      if (paired) {
        const nextHostId = await mod.provisionCloudRelaySessionProfiles(hostProfiles, paired);
        enterSelectedHost(nextHostId);
      }
    },
    [enterSelectedHost, hostProfiles, hubOverview, hubSession, localPairedSessions],
  );

  const handleSubmitLink = useCallback(async () => {
    const raw = linkValue.trim();
    if (!raw || connectingLink) return;
    setConnectingLink(true);
    setLocalError(undefined);
    setPasskeyGuideVisible(false);
    try {
      const mod = await import("../runtime/cloud-relay-client");
      const claim = mod.parseClaimTicketFromUrl(raw);
      if (claim) {
        setClaimPreview(claim);
        setLinkValue("");
        return;
      }
      const session = await mod.redeemCloudRelayUrl(raw, async (readySession) => {
        const nextHostId = await mod.provisionCloudRelaySessionProfiles(hostProfiles, readySession);
        setLocalPairedSessions(mod.listStoredCloudRelaySessions());
        enterSelectedHost(nextHostId);
      });
      const currentBanner = getCloudRelayPairingState();
      if (!session && currentBanner.phase !== "pending_approval" && currentBanner.phase !== "error") {
        setLocalError(intl.formatMessage(remoteWelcomeMessages.invalidLink));
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnectingLink(false);
    }
  }, [connectingLink, enterSelectedHost, hostProfiles, intl, linkValue]);

  const handleSubmitServer = useCallback(() => {
    const raw = serverValue.trim();
    if (!raw || connectingServer) return;
    let origin: string;
    try {
      origin = remoteServerOrigin(raw);
    } catch {
      setLocalError(intl.formatMessage(remoteWelcomeMessages.invalidServer));
      return;
    }
    setLocalError(undefined);
    setConnectingServer(true);
    window.location.assign(origin);
  }, [connectingServer, intl, serverValue]);

  const handleDownloadDesktop = useCallback(() => {
    window.open("https://opencraft.app", "_blank", "noopener,noreferrer");
  }, []);

  const handleHaptic = useCallback((style: string) => {
    requestMobileHaptic(style === "warning" ? "warning" : style === "light" ? "light" : "selection");
  }, []);

  const errorMessage = localError ?? (pairingState.phase === "error" ? pairingState.errorMessage : undefined);
  const pendingShortCode = pairingState.phase === "pending_approval" ? pairingState.shortCode : undefined;
  const hubSignedIn = hubSession !== null;

  const hubMachines = useMemo(() => {
    const items: Array<{
      machineId: string;
      displayName: string;
      online: boolean;
      statusLabel: string;
      connectLabel: string;
      threads: Array<{
        threadId: string;
        title: string;
        statusLabel: string;
        statusTone: "active" | "waiting" | "danger" | "muted";
      }>;
    }> = [];
    const seenMachineIds = new Set<string>();

    if (hubOverview) {
      const threadsByMachine = new Map<string, PersonalHubOverview["threadIndex"][number][]>();
      for (const item of hubOverview.threadIndex) {
        const list = threadsByMachine.get(item.machineId) ?? [];
        if (list.length < 6) {
          list.push(item);
          threadsByMachine.set(item.machineId, list);
        }
      }
      for (const m of hubOverview.machines) {
        seenMachineIds.add(m.machineId);
        items.push({
          machineId: m.machineId,
          displayName: m.displayName,
          online: m.online,
          statusLabel: m.online
            ? intl.formatMessage(remoteWelcomeMessages.hubMachineOnline)
            : intl.formatMessage(remoteWelcomeMessages.hubMachineOffline),
          connectLabel: intl.formatMessage(remoteWelcomeMessages.hubOpenWorkspace),
          threads: (threadsByMachine.get(m.machineId) ?? []).map((t) => ({
            threadId: t.threadId,
            title: t.title,
            statusLabel:
              t.status === "running"
                ? intl.formatMessage(remoteWelcomeMessages.threadRunning)
                : t.status === "waiting"
                  ? intl.formatMessage(remoteWelcomeMessages.threadWaiting)
                  : t.status === "failed"
                    ? intl.formatMessage(remoteWelcomeMessages.threadFailed)
                    : intl.formatMessage(remoteWelcomeMessages.threadIdle),
            statusTone:
              t.status === "running"
                ? ("active" as const)
                : t.status === "waiting"
                  ? ("waiting" as const)
                  : t.status === "failed"
                    ? ("danger" as const)
                    : ("muted" as const),
          })),
        });
      }
    }

    // Also include QR-paired or collaborator-shared sessions when browsing from Connected Workbench
    if (!hubSignedIn && hasConnectedHost) {
      for (const s of localPairedSessions) {
        const key = s.grantId ? s.sessionKey : s.machineId;
        if (seenMachineIds.has(key) || seenMachineIds.has(s.machineId)) continue;
        seenMachineIds.add(key);
        items.push({
          machineId: key,
          displayName: s.displayName,
          online: true,
          statusLabel: intl.formatMessage(remoteWelcomeMessages.hubMachinePaired),
          connectLabel: intl.formatMessage(remoteWelcomeMessages.hubOpenWorkspace),
          threads: [],
        });
      }
    }

    return items;
  }, [hasConnectedHost, hubOverview, hubSignedIn, intl, localPairedSessions]);

  useLayoutEffect(() => {
    const stage = containerRef.current?.closest(".remote-welcome-standalone-stage");
    if (!(stage instanceof HTMLElement)) return;
    stage.dataset.standaloneDark = effectiveDark ? "true" : "false";
    return () => {
      delete stage.dataset.standaloneDark;
    };
  }, [effectiveDark]);

  const viewModel = useMemo(
    (): import("@opencraft/design-system-web/valdi").RemoteWorkbenchWelcomeProps => ({
      dark: effectiveDark,
      touch,
      narrow,
      title: intl.formatMessage(remoteWelcomeMessages.title),
      subtitle: intl.formatMessage(remoteWelcomeMessages.subtitle),
      passkeySupported,
      passkeyBusy,
      hubSignedIn,
      hubSignInLabel: intl.formatMessage(remoteWelcomeMessages.hubSignIn),
      hubCardTitle: intl.formatMessage(remoteWelcomeMessages.hubMachinesTitle),
      hubMachineCountLabel:
        hubMachines.length > 0
          ? intl.formatMessage(remoteWelcomeMessages.hubMachineCount, { count: hubMachines.length })
          : undefined,
      hubAddDeviceHint: intl.formatMessage(remoteWelcomeMessages.hubAddDeviceHint),
      hubPasteTempLinkLabel: intl.formatMessage(remoteWelcomeMessages.hubPasteTempLink),
      hubRefreshLabel: intl.formatMessage(remoteWelcomeMessages.hubRefresh),
      hubSignOutLabel: hubSignedIn
        ? intl.formatMessage(remoteWelcomeMessages.hubSignOut)
        : intl.formatMessage(remoteWelcomeMessages.disconnectBrowser),
      backToWorkspaceLabel: hasConnectedHost ? intl.formatMessage(remoteWelcomeMessages.backToWorkspace) : undefined,
      hubEmptyMachinesText: intl.formatMessage(remoteWelcomeMessages.hubEmptyMachines),
      hubMachines,
      claimMachineName: claimPreview?.displayName,
      claimBannerTitle: claimPreview ? intl.formatMessage(remoteWelcomeMessages.claimBannerTitle) : undefined,
      claimBannerDescription: claimPreview
        ? intl.formatMessage(remoteWelcomeMessages.claimBannerDesc, { name: claimPreview.displayName })
        : undefined,
      claimWithExistingPasskeyLabel: intl.formatMessage(remoteWelcomeMessages.claimExistingPasskey),
      claimWithNewPasskeyLabel: intl.formatMessage(remoteWelcomeMessages.claimNewPasskey),
      claimConfirmCurrentHubLabel: intl.formatMessage(remoteWelcomeMessages.claimConfirmCurrent),
      claimPrivacyHint: intl.formatMessage(remoteWelcomeMessages.claimPrivacyHint),
      cancelClaimLabel: intl.formatMessage(remoteWelcomeMessages.cancelClaim),
      orPasteLinkLabel: intl.formatMessage(remoteWelcomeMessages.orPasteLink),
      linkLabel: intl.formatMessage(remoteWelcomeMessages.linkLabel),
      linkPlaceholder: intl.formatMessage(remoteWelcomeMessages.linkPlaceholder),
      linkValue,
      connectLinkLabel: intl.formatMessage(remoteWelcomeMessages.connectLink),
      connectingLabel: intl.formatMessage(remoteWelcomeMessages.connecting),
      connectingLink: connectingLink || pairingState.phase === "redeeming",
      downloadActionLabel: intl.formatMessage(remoteWelcomeMessages.downloadAction),
      pendingCodeTitle: intl.formatMessage(remoteWelcomeMessages.pendingTitle),
      pendingCodeDetail: intl.formatMessage(remoteWelcomeMessages.pendingDetail),
      pendingShortCode,
      infoTitle: passkeyGuideVisible ? intl.formatMessage(remoteWelcomeMessages.passkeyNotFoundTitle) : undefined,
      infoMessage: passkeyGuideVisible ? intl.formatMessage(remoteWelcomeMessages.passkeyNotFoundDesc) : undefined,
      errorMessage,
      serverDisclosureTitle: intl.formatMessage(remoteWelcomeMessages.serverDisclosure),
      serverAddressLabel: intl.formatMessage(remoteWelcomeMessages.serverAddress),
      serverPlaceholder: "https://workbench.example.com",
      serverValue,
      connectServerLabel: intl.formatMessage(remoteWelcomeMessages.connectServer),
      connectingServer,
      clearLabel: intl.formatMessage(remoteWelcomeMessages.clear),
      onPasskeySignIn: () => {
        void handlePasskeySignIn();
      },
      onPasskeyCreate: () => {
        void handlePasskeyCreate();
      },
      onClaimConfirmCurrentHub: () => {
        void handleConfirmClaimCurrentHub();
      },
      onDismissClaim: () => {
        setClaimPreview(null);
        if (hasConnectedHost) onClosePortal?.();
      },
      onHubRefresh: () => {
        void handleHubRefresh();
      },
      onHubSignOut: () => {
        void handleHubSignOut();
      },
      onBackToWorkspace: hasConnectedHost
        ? () => {
            try {
              window.sessionStorage.setItem("opencraft.hub-entered-session", "1");
            } catch {}
            onClosePortal?.();
          }
        : undefined,
      onDismissInfo: () => {
        setPasskeyGuideVisible(false);
      },
      onConnectHubMachine: (id) => {
        void handleConnectHubMachine(id);
      },
      onChangeLink: (val) => {
        setLinkValue(val);
        if (localError) setLocalError(undefined);
      },
      onSubmitLink: () => {
        void handleSubmitLink();
      },
      onDownloadDesktop: handleDownloadDesktop,
      onChangeServer: (val) => {
        setServerValue(val);
        if (localError) setLocalError(undefined);
      },
      onSubmitServer: handleSubmitServer,
      onDismissError: () => {
        setLocalError(undefined);
        dismissCloudRelayPairingState();
      },
      onHaptic: handleHaptic,
    }),
    [
      claimPreview,
      connectingLink,
      connectingServer,
      effectiveDark,
      errorMessage,
      handleConfirmClaimCurrentHub,
      handleConnectHubMachine,
      handleDownloadDesktop,
      handleHaptic,
      handleHubRefresh,
      handleHubSignOut,
      handlePasskeyCreate,
      handlePasskeySignIn,
      handleSubmitLink,
      handleSubmitServer,
      hasConnectedHost,
      hubMachines,
      hubSignedIn,
      intl,
      linkValue,
      localError,
      narrow,
      onClosePortal,
      pairingState.phase,
      passkeyBusy,
      passkeyGuideVisible,
      passkeySupported,
      pendingShortCode,
      serverValue,
      touch,
    ],
  );

  return (
    <div ref={containerRef} className="remote-welcome-standalone-root">
      <Suspense fallback={null}>
        <LazyValdiRemoteWelcome viewModel={viewModel} />
      </Suspense>
    </div>
  );
}
