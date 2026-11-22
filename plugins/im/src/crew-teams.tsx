import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { IconButton } from "@opencraft/design-system-web/button";
import { SettingsGearIcon } from "@opencraft/design-system-web/action-icons";
import type { CrewTeam, CrewPhonebookEntry } from "@opencraft/appserver-protocol";
import { SettingsButton, type ExtensionSettingsViewProps } from "@opencraft/extension-react";
import { useIntl } from "@opencraft/i18n/react";
import type { ChannelRpc } from "./channel-client";
import { CrewDeskButton } from "./crew-desk-button";
import "./crew-teams.scss";

// The desk and the settings dialog bring heavier code; they load when first opened.
const CrewDesk = lazy(() => import("./crew-desk").then(m => ({ default: m.CrewDesk })));
const CrewTeamSettings = lazy(() => import("./crew-team-settings").then(m => ({ default: m.CrewTeamSettings })));
const CrewTeamStart = lazy(() => import("./crew-team-settings").then(m => ({ default: m.CrewTeamStart })));

const messages = {
  count: { id: "crew.teams.count", defaultMessage: "{count, plural, one {# member} other {# members}}" },
  settings: { id: "crew.teams.settings", defaultMessage: "Manage {name}" },
  create: { id: "crew.teams.create", defaultMessage: "New team" },
  join: { id: "crew.teams.join", defaultMessage: "Join a team" },
};
const REFRESH_MS = 30_000;

export type CrewTeamPerson = CrewPhonebookEntry;

/**
 * The teams part of the Inbox Members tab: each Server space the reader belongs to, with its people
 * and Agents. The Core decides membership and who may manage a team; this view only groups it.
 * Without team support on the Host it renders nothing and the plain member list stays as it was.
 */
export function CrewTeams({ rpc, signal, renderMember, onTeamed, reportError }: {
  rpc: ChannelRpc;
  signal: AbortSignal;
  /** The Members tab's own row, so people look the same in and out of a team. */
  renderMember(person: CrewTeamPerson, reachable: boolean, trailing?: ReactNode): ReactNode;
  /** Everyone shown in a team, so the plain list below can leave them out. */
  onTeamed(actorIds: ReadonlySet<string>): void;
  reportError: ExtensionSettingsViewProps["reportError"];
}) {
  const intl = useIntl();
  const [teams, setTeams] = useState<CrewTeam[] | null>(null);
  const [managing, setManaging] = useState<string | null>(null);
  const [desk, setDesk] = useState<CrewTeamPerson | null>(null);
  const [starting, setStarting] = useState<"create" | "join" | null>(null);
  const life = useRef<AbortController | null>(null);

  async function load() {
    const c = life.current;
    if (!c) return;
    try {
      await rpc.connect();
      const result = await rpc.request("opencraft/crew/teams", {}, c.signal);
      if (!c.signal.aborted) setTeams(result.teams);
    } catch {
      // A Host without teams keeps the plain list; a failed refresh keeps the teams already shown.
    }
  }
  useEffect(() => {
    const c = new AbortController(), retire = () => c.abort();
    life.current = c;
    signal.addEventListener("abort", retire, { once: true });
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => { clearInterval(timer); signal.removeEventListener("abort", retire); c.abort(); life.current = null; };
  }, [rpc, signal]);
  useEffect(() => {
    onTeamed(new Set((teams ?? []).flatMap(team => team.members.map(member => member.actorId))));
  }, [teams]);

  // No answer yet, or a Host without teams: the Members tab stays as it was.
  if (!teams) return null;
  const open = teams.find(team => team.id === managing) ?? null;
  return <>
    {teams.map(team => <section className="crew-team" key={team.id} aria-label={team.name}>
      <header className="crew-team__header">
        <h3>{team.name}<small>{intl.formatMessage(messages.count, { count: team.members.length })}</small></h3>
        {team.role === "owner" ? <IconButton variant="ghost" size="accessory" aria-label={intl.formatMessage(messages.settings, { name: team.name })}
          onClick={() => setManaging(team.id)}><SettingsGearIcon /></IconButton> : null}
      </header>
      <div className="people-members">
        {team.members.map(member => {
          // Agents of your team are always reachable; people are when the team lets members contact each other.
          const reachable = member.kind === "session" || team.openContact;
          return <div className="crew-team__row" key={member.actorId}>
            {renderMember(member, reachable, member.kind === "session" ? <CrewDeskButton bot={member} onOpen={() => setDesk(member)} /> : undefined)}
          </div>;
        })}
      </div>
    </section>)}
    <div className="crew-team__start">
      <SettingsButton variant="quiet" onClick={() => setStarting("create")}>{intl.formatMessage(messages.create)}</SettingsButton>
      <SettingsButton variant="quiet" onClick={() => setStarting("join")}>{intl.formatMessage(messages.join)}</SettingsButton>
    </div>
    {starting ? <Suspense fallback={null}>
      <CrewTeamStart rpc={rpc} mode={starting} reportError={reportError} onChanged={setTeams} onClose={() => setStarting(null)} />
    </Suspense> : null}
    {open ? <Suspense fallback={null}>
      <CrewTeamSettings rpc={rpc} team={open} reportError={reportError} onChanged={setTeams} onClose={() => setManaging(null)} />
    </Suspense> : null}
    {desk ? <Suspense fallback={null}><CrewDesk rpc={rpc} bot={desk} open onOpenChange={next => { if (!next) setDesk(null); }} /></Suspense> : null}
  </>;
}
