import { useEffect, useRef, useState } from "react";
import {
  SettingsButton,
  SettingsChoiceSelect,
  SettingsGroup,
  SettingsRow,
  type ExtensionSettingsViewProps,
} from "@opencraft/extension-react";
import { encodeConversationRef } from "@opencraft/appserver-protocol/collaboration";
import type { AssistantThreadProfile } from "@opencraft/appserver-protocol";
import { useIntl } from "@opencraft/i18n/react";
import type { ChannelRpc } from "./channel-client";

const messages = {
  error: {
    id: "people.thread.error",
    defaultMessage: "Access was not saved. Try again.",
  },
  saved: {
    id: "people.thread.saved",
    defaultMessage: "Previously selected conversation",
  },
  title: {
    id: "people.thread.title",
    defaultMessage: "Let the assistant start tasks",
  },
  about: {
    id: "people.thread.about",
    defaultMessage:
      "The assistant can create and follow up on conversations using the selected conversation’s working directory, model and permissions. Turning this off stops new tasks; existing conversations stay yours.",
  },
  source: {
    id: "people.thread.source",
    defaultMessage: "Use settings from",
  },
  choose: {
    id: "people.thread.choose",
    defaultMessage: "Choose a conversation",
  },
  update: {
    id: "people.thread.update",
    defaultMessage: "Save",
  },
  allow: {
    id: "people.thread.allow",
    defaultMessage: "Allow",
  },
  disable: {
    id: "people.thread.disable",
    defaultMessage: "Turn off",
  },
  more: {
    id: "people.thread.more",
    defaultMessage: "More conversations",
  },
};

/** Human-only grant editor. Merely visiting Everyone never enables execution. */
export function AssistantThreadSettings({
  rpc,
  reportError,
  botId,
}: {
  rpc: ChannelRpc;
  botId?:string;
  reportError: ExtensionSettingsViewProps["reportError"];
}) {
  const intl = useIntl();
  const f = (key: keyof typeof messages) => intl.formatMessage(messages[key]);
  const [profile, setProfile] = useState<AssistantThreadProfile | null>(null),
    [selection, setSelection] = useState("");
  const [sources, setSources] = useState<{ value: string; label: string }[]>(
      [],
    ),
    [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false),
    [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false);
  const life = useRef<AbortController | null>(null),
    busy = useRef<AbortController | null>(null);
  const warn = () =>
    reportError?.({ key: "assistant-thread-settings", message: f("error") });
  async function load(more = false) {
    const c = life.current;
    if (!c || busy.current === c) return;
    busy.current = c;
    setLoading(true);
    try {
      await rpc.connect();
      const [grants, result] = await Promise.all([
        rpc.request(
          "opencraft/personal-assistant/threads/profiles",
          botId?{botId}:{},
          c.signal,
        ),
        rpc.request(
          "opencraft/personal-assistant/threads/sources",
          {...(botId?{botId}:{}),...(more&&cursor?{cursor}:{})},
          c.signal,
        ),
      ]);
      if (c.signal.aborted) return;
      const current = grants.profiles.find((p) => p.id === "default") ?? null;
      setProfile(current);
      const rows = result.conversations.map((v) => ({
        value: encodeConversationRef(v.ref),
        label: v.title || v.ref.threadId,
      }));
      if (current && !rows.some((v) => v.value === current.source))
        rows.unshift({ value: current.source, label: f("saved") });
      setSources((previous) =>
        more
          ? [
              ...previous,
              ...rows.filter((r) => !previous.some((p) => p.value === r.value)),
            ]
          : rows,
      );
      setSelection((previous) => previous || current?.source || "");
      setCursor(result.nextCursor);
      setLoaded(true);
    } catch {
      if (!c.signal.aborted && more) warn();
    } finally {
      if (busy.current === c) busy.current = null;
      if (!c.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    const c = new AbortController();
    life.current = c;
    void load();
    return () => {
      c.abort();
      life.current = null;
    };
  }, []);
  async function save(revoke = false) {
    const c = life.current;
    if (!c || busy.current === c || !loaded) return;
    busy.current = c;
    setSaving(true);
    try {
      if (revoke)
        await rpc.request(
          "opencraft/personal-assistant/threads/profile/revoke",
          { ...(botId?{botId}:{}),
            id: "default", expectedRevision: profile?.revision ?? 0 },
          c.signal,
        );
      else
        await rpc.request(
          "opencraft/personal-assistant/threads/profile/set",
          {
            ...(botId?{botId}:{}),
            id: "default",
            reference: selection,
            expectedRevision: profile?.revision ?? 0,
          },
          c.signal,
        );
      if (c.signal.aborted) return;
      const result = await rpc.request(
        "opencraft/personal-assistant/threads/profiles",
        botId?{botId}:{},
        c.signal,
      );
      if (!c.signal.aborted)
        setProfile(result.profiles.find((p) => p.id === "default") ?? null);
    } catch {
      if (!c.signal.aborted) {
        setLoaded(false);
        warn();
      }
    } finally {
      if (busy.current === c) busy.current = null;
      if (!c.signal.aborted) setSaving(false);
    }
  }
  return (
    <SettingsGroup>
      <SettingsRow label={f("title")} description={f("about")}>
        <div className="people-actions">
          <SettingsChoiceSelect
            label={f("source")}
            placeholder={f("choose")}
            value={selection}
            options={sources}
            disabled={saving || loading || !sources.length}
            onValueChange={setSelection}
          />
          {!profile?.enabled || selection !== profile.source ? (
            <SettingsButton
              variant="primary"
              disabled={saving || loading || !loaded || !selection}
              loading={saving}
              onClick={() => void save()}
            >
              {profile?.enabled ? f("update") : f("allow")}
            </SettingsButton>
          ) : null}
          {profile?.enabled ? (
            <SettingsButton
              disabled={saving || loading}
              onClick={() => void save(true)}
            >
              {f("disable")}
            </SettingsButton>
          ) : null}
          {cursor ? (
            <SettingsButton
              variant="quiet"
              disabled={saving || loading}
              loading={loading}
              onClick={() => void load(true)}
            >
              {f("more")}
            </SettingsButton>
          ) : null}
        </div>
      </SettingsRow>
    </SettingsGroup>
  );
}
