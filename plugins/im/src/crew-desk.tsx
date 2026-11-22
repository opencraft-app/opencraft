import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ModalContent } from "@opencraft/design-system-web/modal-content";
import { IconButton } from "@opencraft/design-system-web/button";
import { CloseIcon } from "@opencraft/design-system-web/action-icons";
import { NavigationList, NavigationItem } from "@opencraft/design-system-web/navigation";
import { SettingsButton } from "@opencraft/extension-react";
import { MessageTimeline, type MessageTimelineCheckpoint } from "@opencraft/chat-render-web/message-timeline";
import { WebChatDocument } from "@opencraft/chat-render-web";
import { createConversationKey, encodeConversationKey } from "@opencraft/chat-core";
import { CHANNELS_HOST_ID, type CrewDesk as Desk, type CrewPhonebookEntry } from "@opencraft/appserver-protocol";
import { useIntl } from "@opencraft/i18n/react";
import type { ChannelRpc } from "./channel-client";
import { ChatAvatar } from "./channel-chat-ui";
import { CompanionAvatar } from "@opencraft/design-system-web/companion-avatar";

/** A navigation row's leading mark: an Agent's companion or a person's initial, at the slot's size. */
function SlotAvatar({ person }: { person: CrewPhonebookEntry }) {
  return (
    <span className="crew-desk__mark" aria-hidden="true">
      {person.kind === "session" ? (
        <CompanionAvatar id={person.actorId} size={20} />
      ) : (
        Array.from(person.displayName.trim()).slice(0, 1).join("").toLocaleUpperCase()
      )}
    </span>
  );
}
import "./crew-desk.scss";

const messages = {
  title: { id: "crew.desk.title", defaultMessage: "{name}’s desk" },
  about: {
    id: "crew.desk.about",
    defaultMessage:
      "What this Agent works with, and its conversations as it sees them. Everyone in its Server can look.",
  },
  environment: { id: "crew.desk.environment", defaultMessage: "Environment" },
  local: { id: "crew.desk.local", defaultMessage: "Host machine" },
  sandbox: { id: "crew.desk.sandbox", defaultMessage: "Sandbox · {template}" },
  model: { id: "crew.desk.model", defaultMessage: "Model" },
  noModel: { id: "crew.desk.noModel", defaultMessage: "Not selected" },
  contacts: { id: "crew.desk.contacts", defaultMessage: "Contacts" },
  contactCount: { id: "crew.desk.contactCount", defaultMessage: "{count, plural, one {# person} other {# people}}" },
  conversations: { id: "crew.desk.conversations", defaultMessage: "Conversations" },
  tasks: { id: "crew.desk.tasks", defaultMessage: "Tasks" },
  noTasks: { id: "crew.desk.noTasks", defaultMessage: "No tasks in this conversation" },
  empty: { id: "crew.desk.empty", defaultMessage: "No one has given this Agent work yet." },
  unavailable: {
    id: "crew.desk.unavailable",
    defaultMessage: "This Agent is not running, so its desk cannot be shown.",
  },
  failed: { id: "crew.desk.failed", defaultMessage: "Could not load the desk." },
  retry: { id: "crew.desk.retry", defaultMessage: "Try again" },
  close: { id: "crew.desk.close", defaultMessage: "Close" },
  latest: { id: "crew.desk.latest", defaultMessage: "Back to latest" },
};
const statuses = {
  queued: { id: "crew.desk.status.queued", defaultMessage: "Waiting to start" },
  running: { id: "crew.desk.status.running", defaultMessage: "Working" },
  waiting_input: { id: "crew.desk.status.waitingInput", defaultMessage: "Waiting for an answer" },
  awaiting_review: { id: "crew.desk.status.review", defaultMessage: "Checking the result" },
  awaiting_delivery: { id: "crew.desk.status.delivery", defaultMessage: "Preparing the result" },
  blocked: { id: "crew.desk.status.blocked", defaultMessage: "Needs attention" },
  completed: { id: "crew.desk.status.completed", defaultMessage: "Completed" },
  cancelled: { id: "crew.desk.status.cancelled", defaultMessage: "Stopped" },
  failed: { id: "crew.desk.status.failed", defaultMessage: "Could not complete" },
} as const;
const REFRESH_MS = 5_000;
type Entry = {
  timelineKey: string;
  estimatedHeightPx: number;
  message: NonNullable<Desk["selected"]>["messages"][number];
};

/** The open dialog owns one read lifetime; the selected dispatcher is the only view state. */
export function CrewDesk({
  rpc,
  bot,
  open,
  onOpenChange,
}: {
  rpc: ChannelRpc;
  bot: CrewPhonebookEntry;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const intl = useIntl();
  const f = (key: keyof typeof messages, values?: Record<string, string | number>) =>
    intl.formatMessage(messages[key], values);
  const [desk, setDesk] = useState<Desk | null>(null);
  const [failure, setFailure] = useState<"unavailable" | "failed" | null>(null);
  const [actorId, setActorId] = useState<string | undefined>();
  const checkpoint = useRef<MessageTimelineCheckpoint | undefined>(undefined);
  const life = useRef<AbortController | null>(null),
    latest = useRef(0),
    wanted = useRef<string | undefined>(undefined);
  wanted.current = actorId;

  // Every read is numbered; only the newest one may change what is shown. A switch never waits
  // for an older read, and a late answer for a conversation already left is dropped.
  async function load() {
    const c = life.current,
      asked = wanted.current,
      ticket = ++latest.current;
    if (!c) return;
    try {
      await rpc.connect();
      const result = await rpc.request(
        "opencraft/crew/desk",
        { botId: bot.actorId, ...(asked ? { actorId: asked } : {}) },
        c.signal,
      );
      if (!c.signal.aborted && ticket === latest.current) {
        setDesk(result);
        setFailure(null);
      }
    } catch (error) {
      if (!c.signal.aborted && ticket === latest.current)
        setFailure(
          (error as { code?: string })?.code === "crew_desk_unavailable" || /crew_desk_unavailable/.test(String(error))
            ? "unavailable"
            : "failed",
        );
    }
  }
  useEffect(() => {
    if (!open) return;
    const c = new AbortController();
    life.current = c;
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      clearInterval(timer);
      c.abort();
      life.current = null;
    };
  }, [open, rpc, bot.actorId]);
  useEffect(() => {
    checkpoint.current = undefined;
    if (open) void load();
  }, [actorId]);

  const selected = desk?.selected ?? null;
  const conversationId = useMemo(
    () =>
      encodeConversationKey(
        createConversationKey(CHANNELS_HOST_ID, "desk:" + bot.actorId + ":" + (selected?.actor.actorId ?? "")),
      ),
    [bot.actorId, selected?.actor.actorId],
  );
  const entries = useMemo<Entry[]>(
    () =>
      (selected?.messages ?? []).map((message) => ({
        timelineKey: "desk:" + message.id,
        estimatedHeightPx: 96,
        message,
      })),
    [selected],
  );
  const environment = desk
    ? desk.environment.kind === "sandbox"
      ? f("sandbox", { template: desk.environment.templateId })
      : f("local")
    : "";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <ModalContent
        overlayClassName="modal-surface__scrim"
        className="modal-surface crew-desk"
        data-size="workspace"
        aria-describedby={undefined}
      >
        <header className="crew-desk__header">
          <ChatAvatar id={bot.actorId} label={bot.displayName} bot />
          <div className="crew-desk__heading">
            <Dialog.Title>{f("title", { name: bot.displayName })}</Dialog.Title>
            <p>{f("about")}</p>
          </div>
          <Dialog.Close asChild>
            <IconButton aria-label={f("close")}>
              <CloseIcon />
            </IconButton>
          </Dialog.Close>
        </header>
        {desk ? (
          <dl className="crew-desk__setup">
            <div>
              <dt>{f("environment")}</dt>
              <dd>{environment}</dd>
            </div>
            <div>
              <dt>{f("model")}</dt>
              <dd>{desk.model?.modelId ?? f("noModel")}</dd>
            </div>
            <div>
              <dt>{f("contacts")}</dt>
              <dd>{f("contactCount", { count: desk.contacts })}</dd>
            </div>
          </dl>
        ) : null}
        {!desk ? (
          <p className="crew-desk__status" role="status">
            {failure ? (
              <>
                {f(failure)}
                {failure === "failed" ? (
                  <>
                    {" "}
                    <SettingsButton variant="quiet" onClick={() => void load()}>
                      {f("retry")}
                    </SettingsButton>
                  </>
                ) : null}
              </>
            ) : null}
          </p>
        ) : !desk.conversations.length ? (
          <p className="crew-desk__status" role="status">
            {f("empty")}
          </p>
        ) : (
          <div className="crew-desk__body">
            <aside className="crew-desk__aside">
              <NavigationList label={f("conversations")} inset="contained">
                {desk.conversations.map((c) => (
                  <NavigationItem
                    key={c.actor.actorId}
                    aria-current={c.actor.actorId === selected?.actor.actorId ? "page" : undefined}
                    onClick={() => setActorId(c.actor.actorId)}
                  >
                    <SlotAvatar person={c.actor} />
                    <span>{c.actor.displayName}</span>
                  </NavigationItem>
                ))}
              </NavigationList>
              <h3>{f("tasks")}</h3>
              {selected?.works.length ? (
                <ul className="crew-desk__tasks">
                  {selected.works.map((w) => (
                    <li key={w.id}>
                      <span>{w.title}</span>
                      <small>
                        {w.status in statuses
                          ? intl.formatMessage(statuses[w.status as keyof typeof statuses])
                          : w.status}
                      </small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="crew-desk__muted">{f("noTasks")}</p>
              )}
              {failure && desk ? (
                <p className="crew-desk__muted" role="status">
                  {f(failure)}
                </p>
              ) : null}
            </aside>
            {selected ? (
              <MessageTimeline
                key={selected.actor.actorId}
                className="crew-desk__timeline"
                label={f("conversations")}
                latestLabel={f("latest")}
                entries={entries}
                checkpoint={checkpoint.current}
                onCheckpoint={(value) => {
                  checkpoint.current = value;
                }}
                renderEntry={(entry) => {
                  const own = entry.message.role === "assistant",
                    who = own ? bot : (entry.message.author ?? selected.actor);
                  return (
                    <div className="crew-desk__message" data-role={entry.message.role}>
                      <ChatAvatar id={who.actorId} label={who.displayName} bot={who.kind === "session"} />
                      <div>
                        <small>
                          <strong>{who.displayName}</strong> ·{" "}
                          <time dateTime={new Date(entry.message.at).toISOString()}>
                            {intl.formatTime(entry.message.at, { hour: "2-digit", minute: "2-digit" })}
                          </time>
                        </small>
                        <WebChatDocument
                          documentId={"crew-desk:" + entry.message.id}
                          conversationId={conversationId}
                          source={entry.message.text}
                          externalResourcePolicy="restricted"
                        />
                      </div>
                    </div>
                  );
                }}
              />
            ) : null}
          </div>
        )}
      </ModalContent>
    </Dialog.Root>
  );
}
