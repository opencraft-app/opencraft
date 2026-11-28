import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ModalContent } from "@opencraft/design-system-web/modal-content";
import { CompanionAvatar } from "@opencraft/design-system-web/companion-avatar";
import {
  SettingsButton,
  SettingsGroup,
  SettingsPanel,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
  SettingsTextInput,
  type ExtensionSettingsViewProps,
} from "@opencraft/extension-react";
import type { CrewTeam } from "@opencraft/appserver-protocol";
import { useIntl } from "@opencraft/i18n/react";
import type { ChannelRpc } from "./channel-client";
import { CrewPhonebook } from "./crew-phonebook";
import "./crew-teams.scss";

const messages = {
  title: { id: "crew.teams.settingsTitle", defaultMessage: "Manage {name}" },
  contact: { id: "crew.teams.contact", defaultMessage: "Members can contact each other" },
  contactAbout: {
    id: "crew.teams.contactAbout",
    defaultMessage: "Anyone in this team can message any member. Agents still reach only the people in their contacts.",
  },
  agents: { id: "crew.teams.agents", defaultMessage: "Agents" },
  agentsAbout: {
    id: "crew.teams.agentsAbout",
    defaultMessage: "Members give an Agent work by messaging it. Choose who each Agent may contact on its own.",
  },
  noAgents: { id: "crew.teams.noAgents", defaultMessage: "No Agents in this team yet." },
  contacts: { id: "crew.teams.contacts", defaultMessage: "Contacts" },
  hideContacts: { id: "crew.teams.hideContacts", defaultMessage: "Hide contacts" },
  remove: { id: "crew.teams.remove", defaultMessage: "Remove" },
  add: { id: "crew.teams.add", defaultMessage: "Add" },
  addAgents: { id: "crew.teams.addAgents", defaultMessage: "Add an Agent" },
  addAbout: {
    id: "crew.teams.addAbout",
    defaultMessage: "Your own assistants that are not in a team yet. An Agent belongs to one team.",
  },
  noCandidates: {
    id: "crew.teams.noCandidates",
    defaultMessage: "All your assistants are in a team. Create another in Assistants first.",
  },
  close: { id: "crew.teams.close", defaultMessage: "Done" },
  invite: { id: "crew.teams.invite", defaultMessage: "Invite people" },
  inviteAbout: {
    id: "crew.teams.inviteAbout",
    defaultMessage: "Share a link with someone who can sign in here. It works once and expires in 24 hours.",
  },
  inviteCreate: { id: "crew.teams.inviteCreate", defaultMessage: "Create invitation link" },
  inviteLink: { id: "crew.teams.inviteLink", defaultMessage: "Invitation link" },
  copy: { id: "crew.teams.copy", defaultMessage: "Copy" },
  copied: { id: "crew.teams.copied", defaultMessage: "Copied" },
  createTitle: { id: "crew.teams.createTitle", defaultMessage: "New team" },
  createAbout: {
    id: "crew.teams.createAbout",
    defaultMessage:
      "A team is where people and Agents work together. You manage it; invite people and add your Agents after.",
  },
  name: { id: "crew.teams.name", defaultMessage: "Team name" },
  createAction: { id: "crew.teams.createAction", defaultMessage: "Create team" },
  joinTitle: { id: "crew.teams.joinTitle", defaultMessage: "Join a team" },
  joinAbout: {
    id: "crew.teams.joinAbout",
    defaultMessage: "Paste the invitation link or code someone shared with you.",
  },
  joinAction: { id: "crew.teams.joinAction", defaultMessage: "Join" },
  cancel: { id: "crew.teams.cancel", defaultMessage: "Cancel" },
  failed: { id: "crew.teams.failed", defaultMessage: "The team was not changed. Try again." },
};

/**
 * Owner-only team management in the Inbox. Every change goes to the Server space ledger through the
 * Core, which answers with the team as it now is; each row keeps its own pending state.
 */
export function CrewTeamSettings({
  rpc,
  team,
  reportError,
  onChanged,
  onClose,
}: {
  rpc: ChannelRpc;
  team: CrewTeam;
  reportError: ExtensionSettingsViewProps["reportError"];
  onChanged(teams: CrewTeam[]): void;
  onClose(): void;
}) {
  const intl = useIntl();
  const f = (key: keyof typeof messages, values?: Record<string, string>) => intl.formatMessage(messages[key], values);
  const [candidates, setCandidates] = useState<{ actorId: string; displayName: string }[] | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [contactsFor, setContactsFor] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<string | null>(null),
    [copied, setCopied] = useState(false);
  const life = useRef<AbortController | null>(null);
  const agents = team.members.filter((member) => member.kind === "session");

  async function loadCandidates() {
    const c = life.current;
    if (!c) return;
    try {
      const result = await rpc.request("opencraft/crew/team", { action: "candidates", spaceId: team.id }, c.signal);
      if (!c.signal.aborted && "bots" in result) setCandidates(result.bots);
    } catch {
      if (!c.signal.aborted) setCandidates([]);
    }
  }
  useEffect(() => {
    const c = new AbortController();
    life.current = c;
    void loadCandidates();
    return () => {
      c.abort();
      life.current = null;
    };
  }, [rpc, team.id]);

  async function change(key: string, command: Parameters<ChannelRpc["request"]>[1] & object) {
    const c = life.current;
    if (!c || pending.has(key)) return;
    setPending((previous) => new Set(previous).add(key));
    try {
      const result = await rpc.request("opencraft/crew/team", command as never, c.signal);
      if (c.signal.aborted) return;
      if ("teams" in result) onChanged(result.teams);
      await loadCandidates();
    } catch {
      if (!c.signal.aborted) reportError?.({ key: "crew-team", message: f("failed") });
    } finally {
      if (!c.signal.aborted)
        setPending((previous) => {
          const next = new Set(previous);
          next.delete(key);
          return next;
        });
    }
  }

  async function invite() {
    const c = life.current;
    if (!c || pending.has("invite")) return;
    setPending((previous) => new Set(previous).add("invite"));
    try {
      const result = await rpc.request("opencraft/crew/team", { action: "invite", spaceId: team.id }, c.signal);
      if (c.signal.aborted || !("code" in result)) return;
      // The same link shape as the Server panel's invitations, so either place accepts it.
      const url = new URL(window.location.href);
      url.pathname = "/";
      url.search = "";
      url.hash = "";
      url.searchParams.set("serverInvite", result.code);
      setInvitation(url.href);
      setCopied(false);
    } catch {
      if (!c.signal.aborted) reportError?.({ key: "crew-team", message: f("failed") });
    } finally {
      if (!c.signal.aborted)
        setPending((previous) => {
          const next = new Set(previous);
          next.delete("invite");
          return next;
        });
    }
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <ModalContent className="crew-team-settings" data-size="wide">
        <SettingsPanel
          title={
            <Dialog.Title asChild>
              <span>{f("title", { name: team.name })}</span>
            </Dialog.Title>
          }
          footer={
            <SettingsButton variant="primary" onClick={onClose}>
              {f("close")}
            </SettingsButton>
          }
        >
          <SettingsGroup>
            <SettingsRow label={f("contact")} description={f("contactAbout")} layout="stacked">
              <SettingsSwitch
                label={f("contact")}
                checked={team.openContact}
                disabled={pending.has("contact")}
                onCheckedChange={(open) => void change("contact", { action: "contact", spaceId: team.id, open })}
              />
            </SettingsRow>
          </SettingsGroup>
          <SettingsSection title={f("agents")} description={f("agentsAbout")}>
            {agents.length ? (
              <SettingsGroup>
                {agents.map((agent) => (
                  <SettingsRow
                    key={agent.actorId}
                    controlWidth="compact"
                    label={
                      <span className="crew-team-settings__agent">
                        <CompanionAvatar id={agent.actorId} size={24} />
                        {agent.displayName}
                      </span>
                    }
                  >
                    <span className="crew-team-settings__actions">
                      <SettingsButton
                        variant="quiet"
                        onClick={() => setContactsFor(contactsFor === agent.actorId ? null : agent.actorId)}
                      >
                        {f(contactsFor === agent.actorId ? "hideContacts" : "contacts")}
                      </SettingsButton>
                      <SettingsButton
                        variant="quiet"
                        disabled={pending.has(agent.actorId)}
                        onClick={() =>
                          void change(agent.actorId, {
                            action: "removeAgent",
                            spaceId: team.id,
                            actorId: agent.actorId,
                          })
                        }
                      >
                        {f("remove")}
                      </SettingsButton>
                    </span>
                  </SettingsRow>
                ))}
              </SettingsGroup>
            ) : (
              <p className="crew-team-settings__empty">{f("noAgents")}</p>
            )}
          </SettingsSection>
          {contactsFor && agents.some((agent) => agent.actorId === contactsFor) ? (
            <CrewPhonebook key={contactsFor} rpc={rpc} botId={contactsFor} reportError={reportError} />
          ) : null}
          <SettingsSection title={f("invite")} description={f("inviteAbout")}>
            {invitation ? (
              <div className="crew-team-settings__invite">
                <SettingsTextInput
                  aria-label={f("inviteLink")}
                  value={invitation}
                  readOnly
                  onFocus={(event) => event.target.select()}
                />
                <SettingsButton
                  onClick={() =>
                    void navigator.clipboard.writeText(invitation).then(
                      () => setCopied(true),
                      () => undefined,
                    )
                  }
                >
                  {f(copied ? "copied" : "copy")}
                </SettingsButton>
              </div>
            ) : (
              <SettingsButton disabled={pending.has("invite")} onClick={() => void invite()}>
                {f("inviteCreate")}
              </SettingsButton>
            )}
          </SettingsSection>
          <SettingsSection title={f("addAgents")} description={f("addAbout")}>
            {candidates?.length ? (
              <SettingsGroup>
                {candidates.map((bot) => (
                  <SettingsRow
                    key={bot.actorId}
                    controlWidth="compact"
                    label={
                      <span className="crew-team-settings__agent">
                        <CompanionAvatar id={bot.actorId} size={24} />
                        {bot.displayName}
                      </span>
                    }
                  >
                    <SettingsButton
                      disabled={pending.has(bot.actorId)}
                      onClick={() =>
                        void change(bot.actorId, { action: "addAgent", spaceId: team.id, actorId: bot.actorId })
                      }
                    >
                      {f("add")}
                    </SettingsButton>
                  </SettingsRow>
                ))}
              </SettingsGroup>
            ) : candidates ? (
              <p className="crew-team-settings__empty">{f("noCandidates")}</p>
            ) : null}
          </SettingsSection>
        </SettingsPanel>
      </ModalContent>
    </Dialog.Root>
  );
}

/** Starting a team, or joining one by invitation, from the Inbox. */
export function CrewTeamStart({
  rpc,
  mode,
  reportError,
  onChanged,
  onClose,
}: {
  rpc: ChannelRpc;
  mode: "create" | "join";
  reportError: ExtensionSettingsViewProps["reportError"];
  onChanged(teams: CrewTeam[]): void;
  onClose(): void;
}) {
  const intl = useIntl();
  const f = (key: keyof typeof messages) => intl.formatMessage(messages[key]);
  const [value, setValue] = useState(""),
    [busy, setBusy] = useState(false);
  const life = useRef<AbortController | null>(null);
  useEffect(() => {
    const c = new AbortController();
    life.current = c;
    return () => {
      c.abort();
      life.current = null;
    };
  }, []);
  async function submit() {
    const c = life.current,
      input = value.trim();
    if (!c || busy || !input) return;
    let code = input;
    try {
      code = new URL(input).searchParams.get("serverInvite") ?? input;
    } catch {
      /* A bare invitation code. */
    }
    setBusy(true);
    try {
      const result = await rpc.request(
        "opencraft/crew/team",
        mode === "create" ? { action: "create", name: input } : { action: "join", code },
        c.signal,
      );
      if (c.signal.aborted) return;
      if ("teams" in result) onChanged(result.teams);
      onClose();
    } catch {
      if (!c.signal.aborted) reportError?.({ key: "crew-team", message: f("failed") });
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <ModalContent className="crew-team-settings">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <SettingsPanel
            title={
              <Dialog.Title asChild>
                <span>{f(mode === "create" ? "createTitle" : "joinTitle")}</span>
              </Dialog.Title>
            }
            footer={
              <>
                <SettingsButton disabled={busy} onClick={onClose}>
                  {f("cancel")}
                </SettingsButton>
                <SettingsButton type="submit" variant="primary" disabled={busy || !value.trim()} loading={busy}>
                  {f(mode === "create" ? "createAction" : "joinAction")}
                </SettingsButton>
              </>
            }
          >
            <div className="settings-panel-form">
              <p className="crew-team-settings__empty">{f(mode === "create" ? "createAbout" : "joinAbout")}</p>
              <SettingsGroup>
                <SettingsRow layout="stacked" controlWidth="wide" label={f(mode === "create" ? "name" : "inviteLink")}>
                  <SettingsTextInput
                    aria-label={f(mode === "create" ? "name" : "inviteLink")}
                    value={value}
                    maxLength={mode === "create" ? 80 : 2048}
                    autoComplete="off"
                    disabled={busy}
                    onChange={(event) => setValue(event.target.value)}
                  />
                </SettingsRow>
              </SettingsGroup>
            </div>
          </SettingsPanel>
        </form>
      </ModalContent>
    </Dialog.Root>
  );
}
