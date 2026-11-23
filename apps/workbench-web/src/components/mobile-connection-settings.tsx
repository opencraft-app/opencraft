import { useState } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { SettingsActions, SettingsButton, SettingsGroup, SettingsPageHeader, SettingsRow, SettingsTextInput, type ProvisionHostInput } from "@opencraft/extension-react";
import type { HostConnectionProfile } from "@opencraft/workbench-runtime";
import { useOptionalAsyncNotices } from "./async-notices";

import { mobileConnectionMessages } from "./mobile-connection-messages";
export { mobileConnectionMessages } from "./mobile-connection-messages";

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
      <SettingsGroup><SettingsRow label={intl.formatMessage(mobileConnectionMessages.address)} description={intl.formatMessage(mobileConnectionMessages.addressHint)} htmlFor="mobile-server-address" layout="stacked" controlWidth="wide">
        <SettingsTextInput id="mobile-server-address" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} required
          disabled={pending} value={url} onChange={event => setUrl(event.target.value)} />
      </SettingsRow></SettingsGroup>
      <SettingsActions><SettingsButton type="submit" variant="primary" loading={pending} disabled={!url.trim() || pending}>{intl.formatMessage(mobileConnectionMessages.title)}</SettingsButton></SettingsActions>
    </form>
  </>;
}
