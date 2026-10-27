import { useState } from "react";
import { defineMessages } from "@opencraft/i18n";
import { useIntl } from "@opencraft/i18n/react";
import { SettingsActions, SettingsButton, SettingsGroup, SettingsPageHeader, SettingsRow, SettingsTextInput, type ProvisionHostInput } from "@opencraft/extension-react";
import type { HostConnectionProfile } from "@opencraft/workbench-runtime";
import { useOptionalAsyncNotices } from "./async-notices";

export const mobileConnectionMessages = defineMessages({
  title: { id: "mobile.connection.title", defaultMessage: "Connect a server" },
  description: { id: "mobile.connection.description", defaultMessage: "Connect to your OpenCraft server to start working. Your server manages sign-in and access." },
  address: { id: "mobile.connection.address", defaultMessage: "Secure WebSocket address" },
  failed: { id: "mobile.connection.failed", defaultMessage: "The connection could not be saved. Check the address and try again." },
});

export function MobileConnectionSettings({ onProvisionHost }: { onProvisionHost(input: ProvisionHostInput): Promise<HostConnectionProfile> }) {
  const intl = useIntl();
  const notices = useOptionalAsyncNotices();
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const save = async () => {
    setPending(true);
    try {
      const endpoint = new URL(url.trim());
      if (endpoint.protocol !== "wss:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Invalid connection address");
      await onProvisionHost({ displayName: endpoint.host, providerId: "opencraft.websocket", providerConfig: { url: endpoint.href }, hostKind: "remote-control" });
    } catch {
      notices?.error({ key: "mobile-connection-save", message: intl.formatMessage(mobileConnectionMessages.failed) });
    } finally { setPending(false); }
  };
  return <>
    <SettingsPageHeader title={intl.formatMessage(mobileConnectionMessages.title)} description={intl.formatMessage(mobileConnectionMessages.description)} />
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <SettingsGroup><SettingsRow label={intl.formatMessage(mobileConnectionMessages.address)} htmlFor="mobile-server-address" layout="stacked" controlWidth="wide">
        <SettingsTextInput id="mobile-server-address" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} required
          disabled={pending} value={url} onChange={event => setUrl(event.target.value)} />
      </SettingsRow></SettingsGroup>
      <SettingsActions><SettingsButton type="submit" variant="primary" loading={pending} disabled={!url.trim() || pending}>{intl.formatMessage(mobileConnectionMessages.title)}</SettingsButton></SettingsActions>
    </form>
  </>;
}
