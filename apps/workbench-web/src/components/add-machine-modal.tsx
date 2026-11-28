import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ModalSurface } from "@opencraft/design-system-web/modal-surface";
import { useIntl } from "@opencraft/i18n/react";
import type { PersonalMachinesDirectory } from "@opencraft/appserver-protocol";
import { useAppearanceTheme } from "../appearance-theme";
import { requestMobileHaptic } from "../runtime/mobile-valdi-bridge";
import type { PersonalMachinesController } from "../runtime/personal-machine-environment-source";
import type { OperationNotice } from "./notice-history";
import { useValdiTouchDensity } from "./shell-navigation/valdi-sidebar-dock";
import "./valdi-surfaces.scss";

const EMPTY_SUBSCRIBE = () => () => {};
const NULL_DIRECTORY = (): PersonalMachinesDirectory | null => null;

const LazyValdiAddMachine = lazy(async () => {
  const mod = await import("@opencraft/design-system-web/valdi");
  function ValdiAddMachineMount({
    viewModel,
  }: {
    readonly viewModel: import("@opencraft/design-system-web/valdi").AddMachineProps;
  }) {
    return (
      <mod.ValdiSurface
        component={mod.AddMachineSurface}
        viewModel={viewModel}
        className="valdi-add-machine-surface"
        data-testid="valdi-add-machine-surface"
      />
    );
  }
  return { default: ValdiAddMachineMount };
});

export interface AddMachineModalProps {
  readonly personalMachines: PersonalMachinesController;
  readonly portalContainer?: HTMLElement | null;
  readonly returnFocus?: () => HTMLElement | null;
  readonly reportError?: (notice: OperationNotice) => void;
  readonly onClose: () => void;
}

export function AddMachineModal({
  personalMachines,
  portalContainer,
  returnFocus,
  reportError,
  onClose,
}: AddMachineModalProps) {
  const intl = useIntl();
  const appearance = useAppearanceTheme();
  const touch = useValdiTouchDensity();
  const directory = useSyncExternalStore(
    personalMachines ? personalMachines.subscribe : EMPTY_SUBSCRIBE,
    personalMachines ? personalMachines.getDirectorySnapshot : NULL_DIRECTORY,
    NULL_DIRECTORY,
  );
  const [command, setCommand] = useState("");
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [errorText, setErrorText] = useState<string | undefined>(undefined);
  const mountedRef = useRef(true);
  const initialRequestedRef = useRef(false);
  const baselineEnrolledIdsRef = useRef<ReadonlySet<string> | null>(null);

  if (baselineEnrolledIdsRef.current === null && directory !== null) {
    baselineEnrolledIdsRef.current = new Set(
      directory.machines.filter((item) => item.phase === "enrolled" && item.connected).map((item) => item.id),
    );
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const hasEntrance = Boolean(directory?.enrollmentOrigin);

  const generateTicket = useCallback(async () => {
    setGenerating(true);
    setErrorText(undefined);
    setCopied(false);
    try {
      const result = await personalMachines.command({ action: "create" });
      if (!mountedRef.current) return;
      setCommand(result.command ?? "");
    } catch {
      if (!mountedRef.current) return;
      const msg = intl.formatMessage({
        id: "loginAdmission.error.generic",
        defaultMessage: "Couldn't complete the request. Try again.",
      });
      setErrorText(msg);
      reportError?.({ key: "personal-machines:create", message: msg });
    } finally {
      if (mountedRef.current) setGenerating(false);
    }
  }, [intl, personalMachines, reportError]);

  useEffect(() => {
    if (!hasEntrance || initialRequestedRef.current) return;
    initialRequestedRef.current = true;
    void generateTicket();
  }, [generateTicket, hasEntrance]);

  const handleCopy = useCallback(async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      if (mountedRef.current) setCopied(true);
    } catch {
      const msg = intl.formatMessage({
        id: "loginAdmission.error.generic",
        defaultMessage: "Couldn't complete the request. Try again.",
      });
      if (mountedRef.current) setErrorText(msg);
    }
  }, [command, intl]);

  const handleRevoke = useCallback(
    async (id: string) => {
      try {
        await personalMachines.command({ action: "revoke", id });
      } catch {
        const msg = intl.formatMessage({
          id: "loginAdmission.error.generic",
          defaultMessage: "Couldn't complete the request. Try again.",
        });
        if (mountedRef.current) setErrorText(msg);
      }
    },
    [intl, personalMachines],
  );

  const newlyConnectedMachine = useMemo(() => {
    if (!directory) return undefined;
    const baseline = baselineEnrolledIdsRef.current;
    return directory.machines.find(
      (item) => item.phase === "enrolled" && item.connected && (!baseline || !baseline.has(item.id)),
    );
  }, [directory]);

  const pendingSummaries = useMemo(
    () =>
      (directory?.machines ?? [])
        .filter((item) => item.phase === "pending")
        .map((item) => ({
          id: item.id,
          label:
            item.name ||
            intl.formatMessage({ id: "settings.machines.personal.pending", defaultMessage: "Waiting for connection" }),
          detail: intl.formatMessage({
            id: "settings.machines.personal.waitingDetail",
            defaultMessage: "Listening on reverse relay · expires in 15 min",
          }),
        })),
    [directory, intl],
  );

  const modalTitle = intl.formatMessage({ id: "settings.machines.personal.add", defaultMessage: "Add machine" });
  const closeLabel = intl.formatMessage({ id: "settings.machines.personal.close", defaultMessage: "Close" });

  const viewModel = useMemo(
    (): import("@opencraft/design-system-web/valdi").AddMachineProps => ({
      dark: appearance.resolvedTheme === "dark",
      touch,
      badgeLabel: intl.formatMessage({
        id: "settings.machines.personal.badge",
        defaultMessage: "Reverse Relay · Zero Inbound Ports",
      }),
      title: modalTitle,
      subtitle: intl.formatMessage({
        id: "settings.machines.personal.sectionDescription",
        defaultMessage: "Connect your own Mac or Linux machines over a reverse relay without opening inbound ports.",
      }),
      closeLabel,
      platformLabel: intl.formatMessage({
        id: "settings.machines.personal.platformLabel",
        defaultMessage: "Target system",
      }),
      macosLabel: "macOS",
      linuxLabel: "Linux",
      macosHint: intl.formatMessage({
        id: "settings.machines.personal.macosHint",
        defaultMessage: "Installs a user LaunchAgent that reconnects automatically across sleep and reboot.",
      }),
      linuxHint: intl.formatMessage({
        id: "settings.machines.personal.linuxHint",
        defaultMessage: "Installs a systemd --user service in your home directory without requiring root.",
      }),
      commandGroupTitle: intl.formatMessage({
        id: "settings.machines.personal.commandGroup",
        defaultMessage: "One-time enrollment command",
      }),
      commandHint: intl.formatMessage({
        id: "settings.machines.personal.commandHint",
        defaultMessage: "Run this private command on the remote machine within 15 minutes. Do not share it.",
      }),
      generatingLabel: intl.formatMessage({
        id: "settings.machines.personal.generating",
        defaultMessage: "Preparing one-time enrollment ticket…",
      }),
      noEntranceTitle: intl.formatMessage({
        id: "settings.machines.personal.noEntrance",
        defaultMessage: "Remote enrollment entrance is not configured on this server yet.",
      }),
      noEntranceMessage: intl.formatMessage({
        id: "settings.machines.personal.noEntranceDetail",
        defaultMessage: "Start OpenCraft with a public HTTPS relay origin to generate remote enrollment commands.",
      }),
      copyLabel: intl.formatMessage({ id: "settings.machines.personal.copy", defaultMessage: "Copy command" }),
      copiedLabel: intl.formatMessage({ id: "settings.machines.personal.copied", defaultMessage: "Copied" }),
      regenerateLabel: intl.formatMessage({
        id: "settings.machines.personal.regenerate",
        defaultMessage: "New ticket",
      }),
      statusGroupTitle: intl.formatMessage({
        id: "settings.machines.personal.statusGroup",
        defaultMessage: "Relay enrollment status",
      }),
      waitingTitle: intl.formatMessage({
        id: "settings.machines.personal.pending",
        defaultMessage: "Waiting for connection",
      }),
      waitingDetail: intl.formatMessage({
        id: "settings.machines.personal.waitingDetail",
        defaultMessage: "Listening on reverse relay · expires in 15 min",
      }),
      connectedTitle: intl.formatMessage({
        id: "settings.machines.personal.connectedTitle",
        defaultMessage: "Machine connected",
      }),
      connectedMessage: intl.formatMessage({
        id: "settings.machines.personal.connectedMessage",
        defaultMessage: "Ready in Work In and Machines settings.",
      }),
      doneLabel: intl.formatMessage({ id: "settings.machines.personal.done", defaultMessage: "Done" }),
      revokeLabel: intl.formatMessage({ id: "settings.machines.personal.revoke", defaultMessage: "Revoke" }),
      command,
      generating,
      copied,
      hasEntrance,
      error: errorText,
      pendingMachines: pendingSummaries,
      connectedMachineName: newlyConnectedMachine
        ? newlyConnectedMachine.machine?.name || newlyConnectedMachine.name || newlyConnectedMachine.id.slice(0, 8)
        : undefined,
      onCopy: () => {
        void handleCopy();
      },
      onRegenerate: () => {
        void generateTicket();
      },
      onRevoke: (id) => {
        void handleRevoke(id);
      },
      onClose,
      onHaptic: (style: string) => {
        requestMobileHaptic(style === "warning" ? "warning" : style === "light" ? "light" : "selection");
      },
    }),
    [
      appearance.resolvedTheme,
      closeLabel,
      command,
      copied,
      errorText,
      generateTicket,
      generating,
      handleCopy,
      handleRevoke,
      hasEntrance,
      intl,
      modalTitle,
      newlyConnectedMachine,
      onClose,
      pendingSummaries,
      touch,
    ],
  );

  return (
    <ModalSurface
      label={modalTitle}
      closeLabel={closeLabel}
      appearance="utility"
      size="default"
      showCloseButton={false}
      className="valdi-modal-host-surface"
      portalContainer={portalContainer}
      returnFocus={returnFocus}
      onDismiss={() => onClose()}
    >
      <Suspense fallback={null}>
        <LazyValdiAddMachine viewModel={viewModel} />
      </Suspense>
    </ModalSurface>
  );
}
