import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { SettingsPageHeader, type ProvisionHostInput } from "@opencraft/extension-react";
import type { HostConnectionProfile } from "@opencraft/workbench-runtime";
import { remoteServerOrigin } from "@opencraft/plugin-local-account/connections";
import { useAppearanceTheme } from "../appearance-theme";
import { requestMobileHaptic } from "../runtime/mobile-valdi-bridge";
import { useOptionalAsyncNotices } from "./async-notices";
import { mobileConnectionMessages } from "./mobile-connection-messages";
import { useValdiTouchDensity } from "./shell-navigation/valdi-sidebar-dock";
import "./valdi-surfaces.scss";

export { mobileConnectionMessages } from "./mobile-connection-messages";

const LazyValdiServerConnection = lazy(async () => {
  const mod = await import("@opencraft/design-system-web/valdi");
  function ValdiServerConnectionMount({
    viewModel,
  }: {
    readonly viewModel: import("@opencraft/design-system-web/valdi").ServerConnectionProps;
  }) {
    return (
      <mod.ValdiSurface
        component={mod.ServerConnectionSurface}
        viewModel={viewModel}
        className="valdi-server-connection-surface"
        data-testid="valdi-server-connection-surface"
      />
    );
  }
  return { default: ValdiServerConnectionMount };
});

export function MobileConnectionSettings({
  onProvisionHost,
  onConnected,
  onCancel,
  compact = false,
}: {
  readonly onProvisionHost: (input: ProvisionHostInput) => Promise<HostConnectionProfile>;
  readonly onConnected?: (profile: HostConnectionProfile) => void;
  readonly onCancel?: () => void;
  readonly compact?: boolean;
}) {
  const intl = useIntl();
  const appearance = useAppearanceTheme();
  const touch = useValdiTouchDensity();
  const notices = useOptionalAsyncNotices();
  const [pending, setPending] = useState(false);
  const [errorText, setErrorText] = useState<string | undefined>(undefined);
  const [connectedText, setConnectedText] = useState<string | undefined>(undefined);

  const handleConnect = useCallback(
    async (rawUrl: string, rawName: string) => {
      setPending(true);
      setErrorText(undefined);
      setConnectedText(undefined);
      try {
        const origin = remoteServerOrigin(rawUrl.trim());
        const wsEndpoint = new URL("/appserver", origin.replace(/^https:/u, "wss:"));
        const profile = await onProvisionHost({
          displayName: rawName.trim() || wsEndpoint.host,
          providerId: "opencraft.websocket",
          providerConfig: { url: wsEndpoint.href },
          hostKind: "remote-control",
        });
        setConnectedText(intl.formatMessage(mobileConnectionMessages.connected));
        onConnected?.(profile);
      } catch {
        const msg = intl.formatMessage(mobileConnectionMessages.failed);
        setErrorText(msg);
        notices?.error({ key: "mobile-connection-save", message: msg });
      } finally {
        setPending(false);
      }
    },
    [intl, notices, onConnected, onProvisionHost],
  );

  const viewModel = useMemo(
    (): import("@opencraft/design-system-web/valdi").ServerConnectionProps => ({
      dark: appearance.resolvedTheme === "dark",
      touch,
      compact,
      badgeLabel: intl.formatMessage(mobileConnectionMessages.badge),
      title: intl.formatMessage(mobileConnectionMessages.title),
      subtitle: intl.formatMessage(mobileConnectionMessages.description),
      groupTitle: intl.formatMessage(mobileConnectionMessages.group),
      addressLabel: intl.formatMessage(mobileConnectionMessages.address),
      addressPlaceholder: intl.formatMessage(mobileConnectionMessages.addressPlaceholder),
      addressHint: intl.formatMessage(mobileConnectionMessages.addressHint),
      nameLabel: intl.formatMessage(mobileConnectionMessages.nameLabel),
      namePlaceholder: intl.formatMessage(mobileConnectionMessages.namePlaceholder),
      clearLabel: intl.formatMessage(mobileConnectionMessages.clear),
      privacyTitle: intl.formatMessage(mobileConnectionMessages.privacyTitle),
      privacyMessage: intl.formatMessage(mobileConnectionMessages.privacyMessage),
      connectLabel: intl.formatMessage(mobileConnectionMessages.title),
      connectingLabel: intl.formatMessage(mobileConnectionMessages.connecting),
      cancelLabel: onCancel ? intl.formatMessage({ id: "mobile.cancel", defaultMessage: "Cancel" }) : undefined,
      pending,
      error: errorText,
      connectedMessage: connectedText,
      onConnect: (url, name) => {
        void handleConnect(url, name);
      },
      onInputChange: () => {
        setErrorText((prev) => (prev === undefined ? prev : undefined));
        setConnectedText((prev) => (prev === undefined ? prev : undefined));
      },
      onCancel,
      onHaptic: (style: string) => {
        requestMobileHaptic(style === "warning" ? "warning" : style === "light" ? "light" : "selection");
      },
    }),
    [appearance.resolvedTheme, compact, connectedText, errorText, handleConnect, intl, onCancel, pending, touch],
  );

  return (
    <Suspense
      fallback={
        !compact ? (
          <SettingsPageHeader
            title={intl.formatMessage(mobileConnectionMessages.title)}
            description={intl.formatMessage(mobileConnectionMessages.description)}
          />
        ) : null
      }
    >
      <LazyValdiServerConnection viewModel={viewModel} />
    </Suspense>
  );
}
