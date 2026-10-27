import { FormattedMessage } from "@opencraft/i18n/react";
import { SettingsButton, SettingsGroup, SettingsPageHeader, SettingsRow } from "@opencraft/extension-react";
import { browserServerContext } from "../runtime/server-context";

/** The relay supplies navigation context; the selected server owns authorization. */
export function ServerSelectionSettings() {
  const server = browserServerContext();
  if (server === null) return null;
  return <>
    <SettingsPageHeader
      title={<FormattedMessage id="settings.servers" defaultMessage="Servers" />}
      description={<FormattedMessage id="settings.servers.description" defaultMessage="Choose which server to use. Access is managed separately on each server." />}
    />
    <SettingsGroup>
      <SettingsRow label={<FormattedMessage id="settings.servers.current" defaultMessage="Current server" />} description={server.name}>
        <SettingsButton onClick={() => window.location.assign(server.selectorPath)}>
          <FormattedMessage id="navigation.switchServer" defaultMessage="Switch server" />
        </SettingsButton>
      </SettingsRow>
    </SettingsGroup>
  </>;
}
