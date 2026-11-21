import { useEffect, useRef, useState, type ReactNode } from "react";
import { ObjectRowButton } from "@opencraft/design-system-web/button";
import { CompanionAvatar } from "@opencraft/design-system-web/companion-avatar";
import { SettingsButton, type ExtensionSettingsViewProps } from "@opencraft/extension-react";
import type { CrewInboxItem } from "@opencraft/appserver-protocol";
import { useIntl } from "@opencraft/i18n/react";
import type { ChannelRpc } from "./channel-client";
import { CrewDesk, CrewDeskButton } from "./crew-desk";
import "./crew-work-view.scss";

const messages = {
  label: { id: "crew.work.label", defaultMessage: "Work" },
  waiting: { id: "crew.work.waiting", defaultMessage: "Waiting on you" },
  open: { id: "crew.work.open", defaultMessage: "In progress" },
  closed: { id: "crew.work.closed", defaultMessage: "Done recently" },
  asks: { id: "crew.work.asks", defaultMessage: "{name}: {text}" },
  from: { id: "crew.work.from", defaultMessage: "From {name}" },
  handedOn: { id: "crew.work.handedOn", defaultMessage: "{count, plural, one {Handed # part on} other {Handed # parts on}}" },
  done: { id: "crew.work.done", defaultMessage: "Done" },
  untitled: { id: "crew.work.untitled", defaultMessage: "Work for {name}" },
  empty: { id: "crew.work.empty", defaultMessage: "No work yet. Message an Agent in your Server to hand it something to do." },
  failed: { id: "crew.work.failed", defaultMessage: "Could not load work." },
  retry: { id: "crew.work.retry", defaultMessage: "Try again" },
  openFailed: { id: "crew.work.openFailed", defaultMessage: "Could not open this conversation." },
};
const REFRESH_MS = 15_000;

/**
 * The crew part of the Inbox. The Core decides what each person may see and whether something is
 * waiting on them; this view only groups it. A refresh keeps the rows on screen and never returns
 * to the cold placeholder; a failed refresh keeps them too and offers a retry in place.
 */
export function CrewWorkList({ rpc, signal, placeholder, onOpenChat, reportError }: {
  rpc: ChannelRpc;
  signal: AbortSignal;
  placeholder: ReactNode;
  onOpenChat(channelId: string): void;
  reportError: ExtensionSettingsViewProps["reportError"];
}) {
  const intl = useIntl();
  const f = (key: keyof typeof messages, values?: Record<string, string | number>) => intl.formatMessage(messages[key], values);
  const [items, setItems] = useState<CrewInboxItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Opening is per row: one pending row never disables the others.
  const [opening, setOpening] = useState<string | null>(null);
  const [desk, setDesk] = useState<CrewInboxItem["work"]["assignee"] | null>(null);
  const life = useRef<AbortController | null>(null), loading = useRef(false);

  async function load() {
    const c = life.current;
    if (!c || loading.current) return;
    loading.current = true;
    try {
      await rpc.connect();
      const result = await rpc.request("opencraft/crew/work/inbox", {}, c.signal);
      if (!c.signal.aborted) { setItems(result.items); setFailed(false); }
    } catch {
      if (!c.signal.aborted) setFailed(true);
    } finally {
      loading.current = false;
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

  async function open(item: CrewInboxItem) {
    const c = life.current, actorId = item.waiting?.from.actorId ?? item.work.assigneeId;
    if (!c || opening) return;
    setOpening(item.work.id);
    try {
      const channel = await rpc.request("opencraft/channels/direct/open", { actorId }, c.signal);
      if (!c.signal.aborted) onOpenChat(channel.id);
    } catch {
      if (!c.signal.aborted) reportError?.({ key: "crew-work-open", message: f("openFailed") });
    } finally {
      if (!c.signal.aborted) setOpening(null);
    }
  }

  if (!items) return failed
    ? <p className="people-status" role="status">{f("failed")} <SettingsButton variant="quiet" onClick={() => void load()}>{f("retry")}</SettingsButton></p>
    : <>{placeholder}</>;
  const groups: [keyof typeof messages, CrewInboxItem[]][] = [
    ["waiting", items.filter(i => i.waiting)],
    ["open", items.filter(i => !i.waiting && i.work.state === "open")],
    ["closed", items.filter(i => i.work.state === "closed")],
  ];
  const requester = (item: CrewInboxItem) => item.work.chain.find(p => p.actorId === item.work.requesterId)?.displayName;
  const detail = (item: CrewInboxItem) => item.waiting
    ? f("asks", { name: item.waiting.from.displayName, text: item.waiting.content })
    : item.work.state === "closed" ? f("done")
      : item.work.openChildren ? f("handedOn", { count: item.work.openChildren })
        : requester(item) ? f("from", { name: requester(item)! }) : f("open");
  return <section className="people-stream crew-work" aria-label={f("label")}>
    {groups.map(([key, rows]) => rows.length ? <div className="crew-work__group" key={key}>
      <h3 className="crew-work__heading">{f(key)}</h3>
      {rows.map(item => <div className="people-group-entry" key={item.work.id}>
        <ObjectRowButton className="people-group" aria-busy={opening === item.work.id} disabled={opening === item.work.id} onClick={() => void open(item)}>
          <span className="people-group-content">
            <span className="people-group-badge-anchor"><CompanionAvatar id={item.work.assignee.actorId} /></span>
            <span className="people-member-copy">
              <strong>{item.work.request?.split("\n")[0] || f("untitled", { name: item.work.assignee.displayName })}</strong>
              <small data-crew-waiting={item.waiting ? "" : undefined}>{
                // A question already names who asks; other states say whose work it is.
                item.waiting ? detail(item) : `${item.work.assignee.displayName} · ${detail(item)}`}</small>
            </span>
            <span className="people-group-meta"><time dateTime={new Date(item.updatedAt).toISOString()}>{
              new Date(item.updatedAt).toDateString() === new Date().toDateString()
                ? intl.formatTime(item.updatedAt, { hour: "2-digit", minute: "2-digit" })
                : intl.formatDate(item.updatedAt, { month: "numeric", day: "numeric" })}</time></span>
          </span>
        </ObjectRowButton>
        <CrewDeskButton bot={item.work.assignee} onOpen={() => setDesk(item.work.assignee)} />
      </div>)}
    </div> : null)}
    {desk ? <CrewDesk rpc={rpc} bot={desk} open onOpenChange={open => { if (!open) setDesk(null); }} /> : null}
    <div role="status" className="people-status">
      {!items.length ? f("empty") : null}
      {failed ? <>{f("failed")} <SettingsButton variant="quiet" onClick={() => void load()}>{f("retry")}</SettingsButton></> : null}
    </div>
  </section>;
}
