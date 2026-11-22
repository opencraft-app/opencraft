import { useEffect, useRef, useState } from "react";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
  type ExtensionSettingsViewProps,
} from "@opencraft/extension-react";
import type { CrewPhonebook as Phonebook } from "@opencraft/appserver-protocol";
import { useIntl } from "@opencraft/i18n/react";
import type { ChannelRpc } from "./channel-client";
import "./crew-phonebook.scss";

const messages = {
  title: { id: "crew.phonebook.title", defaultMessage: "Contacts" },
  about: {
    id: "crew.phonebook.about",
    defaultMessage:
      "The people and Agents in its Server this assistant may contact on its own. Whoever gives it work can always hear back.",
  },
  readOnly: { id: "crew.phonebook.readOnly", defaultMessage: "Only the Server owner can change contacts." },
  agent: { id: "crew.phonebook.agent", defaultMessage: "Agent" },
  member: { id: "crew.phonebook.member", defaultMessage: "Member" },
  empty: { id: "crew.phonebook.empty", defaultMessage: "No one else is in this Server yet." },
  error: { id: "crew.phonebook.error", defaultMessage: "Contacts were not saved. Try again." },
};

/**
 * A Bot's phonebook inside its one Server. The Core owns the entries (exact grants) and decides
 * who may edit; this view only projects them. A Bot outside every Server has no phonebook and
 * the section is not shown.
 */
export function CrewPhonebook({
  rpc,
  botId,
  reportError,
}: {
  rpc: ChannelRpc;
  botId: string;
  reportError: ExtensionSettingsViewProps["reportError"];
}) {
  const intl = useIntl();
  const f = (key: keyof typeof messages) => intl.formatMessage(messages[key]);
  const [book, setBook] = useState<Phonebook | null>(null);
  // Each row saves on its own; one pending switch never disables or reorders the others.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const life = useRef<AbortController | null>(null);

  useEffect(() => {
    const c = new AbortController();
    life.current = c;
    void (async () => {
      try {
        await rpc.connect();
        const result = await rpc.request("opencraft/crew/phonebook/list", { botId }, c.signal);
        if (!c.signal.aborted) setBook(result);
      } catch {
        // Not in a Server, or unreachable: there is no phonebook to show.
      }
    })();
    return () => {
      c.abort();
      life.current = null;
    };
  }, [rpc, botId]);

  async function toggle(actorId: string, present: boolean) {
    const c = life.current;
    if (!c || pending.has(actorId)) return;
    setPending((previous) => new Set(previous).add(actorId));
    try {
      const result = await rpc.request("opencraft/crew/phonebook/set", { botId, actorId, present }, c.signal);
      if (!c.signal.aborted) setBook(result);
    } catch {
      if (!c.signal.aborted) reportError?.({ key: "crew-phonebook", message: f("error") });
    } finally {
      if (!c.signal.aborted)
        setPending((previous) => {
          const next = new Set(previous);
          next.delete(actorId);
          return next;
        });
    }
  }

  if (!book) return null;
  const listed = new Set(book.entries.map((entry) => entry.actorId));
  return (
    <SettingsSection title={f("title")} description={book.editable ? f("about") : `${f("about")} ${f("readOnly")}`}>
      {book.members.length === 0 ? (
        <p className="crew-phonebook__empty">{f("empty")}</p>
      ) : (
        <SettingsGroup>
          {book.members.map((member) => (
            <SettingsRow
              key={member.actorId}
              label={member.displayName}
              description={f(member.kind === "session" ? "agent" : "member")}
            >
              <SettingsSwitch
                label={member.displayName}
                checked={listed.has(member.actorId)}
                disabled={!book.editable || pending.has(member.actorId)}
                onCheckedChange={(present) => void toggle(member.actorId, present)}
              />
            </SettingsRow>
          ))}
        </SettingsGroup>
      )}
    </SettingsSection>
  );
}
