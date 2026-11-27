import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
  StoredPersonalHubSession,
} from "../runtime/cloud-relay-client";
import { requestMobileHaptic } from "../runtime/mobile-valdi-bridge";
import { setLocalPreference } from "../runtime/workbench-application-services";

function useTouchPresentationState(): boolean {
  return useSyncExternalStore(
    (onStoreChange) =>
      typeof document === "undefined" ? () => undefined : subscribeTouchPresentation(document, onStoreChange),
    () => (typeof document === "undefined" ? false : isTouchPresentation(document)),
    () => false,
  );
}

const remoteWelcomeMessages = defineMessages({
  title: { id: "remoteWelcome.title", defaultMessage: "Connect Your Computer" },
  subtitle: {
    id: "remoteWelcome.subtitle",
    defaultMessage: "Agents run locally on your own machine. Verify once to work directly from this browser.",
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
  hubEmptyMachines: {
    id: "remoteWelcome.hubEmptyMachines",
    defaultMessage: "No computers bound yet. Open OpenCraft Desktop → Settings → Remote Control → Bind Passkey.",
  },
  hubMachineOnline: { id: "remoteWelcome.hubMachineOnline", defaultMessage: "Online" },
  hubMachineOffline: { id: "remoteWelcome.hubMachineOffline", defaultMessage: "Offline" },
  hubOpenWorkspace: { id: "remoteWelcome.hubOpenWorkspace", defaultMessage: "Open Workspace" },
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

export function RemoteWorkbenchWelcome({ hostProfiles }: { readonly hostProfiles: HostConnectionProfileStore }) {
  const intl = useIntl();
  const appearance = useAppearanceTheme();
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
  const [claimPreview, setClaimPreview] = useState<ParsedClaimTicketPreview | null>(null);
  const [linkValue, setLinkValue] = useState("");
  const [connectingLink, setConnectingLink] = useState(false);
  const [serverValue, setServerValue] = useState("");
  const [connectingServer, setConnectingServer] = useState(false);
  const [localError, setLocalError] = useState<string | undefined>(undefined);

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
      if (autoEnterOnline && (preferredMachineId || onlineCount === 1)) {
        const chosen = await mod.activateHubMachineInWorkbench(hostProfiles, session, overview, preferredMachineId);
        if (chosen) {
          setLocalPreference("opencraft.active-host-id", chosen);
        }
      }
    },
    [hostProfiles],
  );

  useEffect(() => {
    let cancelled = false;
    void import("../runtime/cloud-relay-client").then(async (mod) => {
      if (cancelled) return;
      setPasskeySupported(mod.isWebAuthnPasskeySupported());
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
        await refreshHubAndMaybeEnter(existingHub, !claim).catch(() => undefined);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [refreshHubAndMaybeEnter]);

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
    try {
      const mod = await import("../runtime/cloud-relay-client");
      const relayOrigin = claimPreview?.relayOrigin ?? "https://relay.opencraft.app";
      const session = await mod.signInPersonalHubWithPasskey(relayOrigin);
      setHubSession(session);
      await executeClaimAndRefresh(session, claimPreview);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setPasskeyBusy(false);
    }
  }, [claimPreview, executeClaimAndRefresh, passkeyBusy]);

  const handlePasskeyCreate = useCallback(async () => {
    if (passkeyBusy) return;
    setPasskeyBusy(true);
    setLocalError(undefined);
    try {
      const mod = await import("../runtime/cloud-relay-client");
      const relayOrigin = claimPreview?.relayOrigin ?? "https://relay.opencraft.app";
      const session = await mod.createPersonalHubWithPasskey(relayOrigin, claimPreview?.displayName);
      setHubSession(session);
      await executeClaimAndRefresh(session, claimPreview);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
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
    mod.clearPersonalHubSession();
    setHubSession(null);
    setHubOverview(null);
  }, []);

  const handleConnectHubMachine = useCallback(
    async (machineId: string) => {
      if (!hubSession || !hubOverview) return;
      const mod = await import("../runtime/cloud-relay-client");
      const chosen = await mod.activateHubMachineInWorkbench(hostProfiles, hubSession, hubOverview, machineId);
      if (chosen) {
        setLocalPreference("opencraft.active-host-id", chosen);
      }
    },
    [hostProfiles, hubOverview, hubSession],
  );

  const handleSubmitLink = useCallback(async () => {
    const raw = linkValue.trim();
    if (!raw || connectingLink) return;
    setConnectingLink(true);
    setLocalError(undefined);
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
        setLocalPreference("opencraft.active-host-id", nextHostId);
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
  }, [connectingLink, hostProfiles, intl, linkValue]);

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
    if (!hubOverview) return [];
    const threadsByMachine = new Map<string, PersonalHubOverview["threadIndex"][number][]>();
    for (const item of hubOverview.threadIndex) {
      const list = threadsByMachine.get(item.machineId) ?? [];
      if (list.length < 6) {
        list.push(item);
        threadsByMachine.set(item.machineId, list);
      }
    }
    return hubOverview.machines.map((m) => ({
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
    }));
  }, [hubOverview, intl]);

  const viewModel = useMemo(
    (): import("@opencraft/design-system-web/valdi").RemoteWorkbenchWelcomeProps => ({
      dark: appearance.resolvedTheme === "dark",
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
      hubSignOutLabel: intl.formatMessage(remoteWelcomeMessages.hubSignOut),
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
      },
      onHubRefresh: () => {
        void handleHubRefresh();
      },
      onHubSignOut: () => {
        void handleHubSignOut();
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
      appearance.resolvedTheme,
      claimPreview,
      connectingLink,
      connectingServer,
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
      hubMachines,
      hubSignedIn,
      intl,
      linkValue,
      localError,
      narrow,
      pairingState.phase,
      passkeyBusy,
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
