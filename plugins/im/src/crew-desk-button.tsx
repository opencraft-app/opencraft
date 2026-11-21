import { IconButton } from "@opencraft/design-system-web/button";
import { MonitorIcon } from "@opencraft/design-system-web/action-icons";
import type { CrewPhonebookEntry } from "@opencraft/appserver-protocol";
import { useIntl } from "@opencraft/i18n/react";

const open = { id: "crew.desk.open", defaultMessage: "Open {name}’s desk" };

/** A desk trigger for a row of work; it carries no state and loads none of the desk. */
export function CrewDeskButton({ bot, onOpen }: { bot: CrewPhonebookEntry; onOpen(): void }) {
  const intl = useIntl();
  return <IconButton variant="ghost" size="accessory" className="crew-desk__trigger"
    aria-label={intl.formatMessage(open, { name: bot.displayName })} onClick={onOpen}><MonitorIcon /></IconButton>;
}
