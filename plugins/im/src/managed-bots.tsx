import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ModalContent } from "@opencraft/design-system-web/modal-content";
import { CompanionAvatar } from "@opencraft/design-system-web/companion-avatar";
import {
  SettingsButton,
  SettingsPanel,
  SettingsTextInput,
  SettingsChoiceSelect,
  SettingsSection,
  SettingsGroup,
  SettingsRow,
} from "@opencraft/extension-react";
import { useIntl } from "@opencraft/i18n/react";
import { createClientId } from "@opencraft/composer-core";
import type {
  BotEnvironment,
  BotEnvironmentCatalog,
  PersonalAssistantStatus,
  PersonalAssistantModelCatalog,
} from "@opencraft/appserver-protocol";
import type { ChannelRpc } from "./channel-client";
import { AssistantMemory } from "./assistant-memory";
import { AssistantThreadSettings } from "./assistant-thread-settings";
import "./managed-bots.scss";
const labels = {
  title: "Additional assistants",
  create: "New assistant",
  name: "Name",
  duties: "Responsibilities",
  environment: "Work environment",
  local: "Local machine",
  localHint: "Local means the assistant execution Host, not this browser or phone.",
  sandboxHint:
    "This workspace is temporary and may be lost after a pause, restart or lease expiry. History and memory are retained. Commands with an unknown outcome are never replayed automatically.",
  e2bUnavailable:
    "E2B templates appear when a sandbox execution provider is connected. An unavailable environment never falls back to local execution.",
  empty: "Create another assistant with its own identity, model, memory and conversation.",
  settings: "Settings",
  chat: "Chat",
  save: "Save",
  cancel: "Cancel",
  pause: "Pause",
  resume: "Resume",
  paused: "Paused",
  memory: "Memory",
  close: "Close",
  loading: "Loading…",
  failed: "Could not complete the request. Refresh or retry; do not create a new request for an unconfirmed result.",
  retry: "Retry",
  chooseModel: "Choose a model",
  model: "Model",
  unavailable: "Unavailable",
  saved: "Saved",
  noModel: "No model selected",
  revision: "Settings changed. Close and reopen settings before saving again.",
  privacy:
    "Each assistant has its own private conversation and memory. Group membership does not grant access to private memory.",
  legacy: "Your default personal assistant is unchanged.",
  settingsImpact:
    "Saving restarts this assistant and requires renewed task authorization. Its history and memory are retained.",
};
type Editor = { status?: PersonalAssistantStatus; name: string; duties: string; environment: BotEnvironment };
/** Existing Bot authority and shared chat surfaces; no renderer-owned Bot identity or execution. */
export function ManagedBots({
  rpc,
  signal,
  onOpen,
}: {
  rpc: ChannelRpc;
  signal: AbortSignal;
  onOpen: (id: string) => void;
}) {
  const intl = useIntl(),
    f = (k: keyof typeof labels) => intl.formatMessage({ id: "bots.manage." + k, defaultMessage: labels[k] });
  const [rows, setRows] = useState<PersonalAssistantStatus[]>(),
    [failed, setFailed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [feedback, setFeedback] = useState("");
  const [editor, setEditor] = useState<Editor>(),
    [catalog, setCatalog] = useState<BotEnvironmentCatalog>(),
    [models, setModels] = useState<PersonalAssistantModelCatalog>(),
    [memory, setMemory] = useState<PersonalAssistantStatus>();
  const life = useRef<AbortController | null>(null),
    lock = useRef(false),
    refreshing = useRef(false),
    memoryGuard = useRef<(() => boolean) | null>(null),
    creation = useRef<{ payload: string; id: string } | null>(null),
    editorEpoch = useRef(0);
  const request = () => {
    const c = life.current;
    if (!c || c.signal.aborted || signal.aborted) throw Error("Retired");
    return c.signal;
  };
  async function refresh() {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const s = request();
      await rpc.connect();
      const result = await rpc.request("opencraft/personal-assistant/bots/list", {}, s);
      if (!s.aborted) {
        setRows(result.bots.filter((r) => r.assistant && !r.assistant.isDefault));
        setFailed(false);
      }
    } catch {
      if (life.current && !life.current.signal.aborted) setFailed(true);
    } finally {
      refreshing.current = false;
    }
  }
  useEffect(() => {
    const c = new AbortController();
    life.current = c;
    const retire = () => c.abort();
    signal.addEventListener("abort", retire, { once: true });
    if (signal.aborted) retire();
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    return () => {
      clearInterval(timer);
      signal.removeEventListener("abort", retire);
      c.abort();
      life.current = null;
    };
  }, [rpc, signal]);
  async function open(status?: PersonalAssistantStatus, retained?: Editor) {
    if (lock.current) return;
    const e = ++editorEpoch.current;
    setEditor(
      retained ?? {
        status,
        name: status?.assistant?.name ?? "",
        duties: status?.assistant?.duties ?? "",
        environment: status?.assistant?.environment ?? { kind: "local" },
      },
    );
    setCatalog(undefined);
    setModels(undefined);
    setError("");
    try {
      const s = request();
      await rpc.connect();
      const env = await rpc.request("opencraft/personal-assistant/environments", {}, s);
      if (s.aborted || e !== editorEpoch.current) return;
      setCatalog(env);
      if (status?.assistant) {
        const m = await rpc.request(
          "opencraft/personal-assistant/models",
          { botId: status.assistant.binding.botId },
          s,
        );
        if (!s.aborted && e === editorEpoch.current) setModels(m);
      }
    } catch {
      if (e === editorEpoch.current && !life.current?.signal.aborted) setError(f("failed"));
    }
  }
  function close() {
    if (lock.current) return;
    editorEpoch.current++;
    setEditor(undefined);
    setError("");
  }
  async function commit() {
    if (!editor || lock.current || !editor.name.trim() || !catalog) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const s = request(),
        body = { name: editor.name.trim(), duties: editor.duties, environment: editor.environment };
      let result: PersonalAssistantStatus;
      if (editor.status?.assistant)
        result = await rpc.request(
          "opencraft/personal-assistant/bots/update",
          {
            ...body,
            botId: editor.status.assistant.binding.botId,
            expectedRevision: editor.status.assistant.configRevision ?? 0,
          },
          s,
        );
      else {
        const payload = JSON.stringify(body);
        if (creation.current?.payload !== payload) creation.current = { payload, id: "create-bot:" + createClientId() };
        result = await rpc.request(
          "opencraft/personal-assistant/bots/create",
          { ...body, clientRequestId: creation.current.id },
          s,
        );
      }
      if (s.aborted) return;
      editorEpoch.current++;
      setEditor(undefined);
      creation.current = null;
      setFeedback(f("saved"));
      await refresh();
    } catch (e) {
      if (!life.current?.signal.aborted)
        setError(e instanceof Error && e.message.includes("conflict") ? f("revision") : f("failed"));
    } finally {
      lock.current = false;
      if (!life.current?.signal.aborted) setBusy(false);
    }
  }
  async function operate(row: PersonalAssistantStatus, action: "pause" | "chat") {
    const a = row.assistant;
    if (!a || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const s = request();
      if (action === "chat") {
        const result = await rpc.request("opencraft/personal-assistant/open", { botId: a.binding.botId }, s);
        if (!s.aborted) onOpen(result.channel.id);
      } else {
        await rpc.request(
          "opencraft/personal-assistant/bots/pause",
          { botId: a.binding.botId, paused: !a.paused, expectedRevision: a.configRevision ?? 0 },
          s,
        );
        if (!s.aborted) await refresh();
      }
    } catch {
      if (!life.current?.signal.aborted) setError(f("failed"));
    } finally {
      lock.current = false;
      if (!life.current?.signal.aborted) setBusy(false);
    }
  }
  async function selectModel(value: string) {
    const a = editor?.status?.assistant,
      m = models?.models.find((m) => JSON.stringify([m.providerId, m.modelId]) === value);
    if (!a || !m || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const s = request();
      const result = await rpc.request(
        "opencraft/personal-assistant/model/set",
        {
          botId: a.binding.botId,
          model: { providerId: m.providerId, modelId: m.modelId },
          expectedRevision: a.modelRevision,
        },
        s,
      );
      if (!s.aborted) {
        setEditor((old) => (old ? { ...old, status: result } : old));
        await refresh();
      }
    } catch {
      if (!life.current?.signal.aborted) setError(f("failed"));
    } finally {
      lock.current = false;
      if (!life.current?.signal.aborted) setBusy(false);
    }
  }
  const environmentValue =
    editor?.environment.kind === "sandbox"
      ? JSON.stringify([editor.environment.backendId, editor.environment.templateId])
      : "local";
  return (
    <SettingsSection title={f("title")}>
      <div className="managed-bots">
        <p className="managed-bots__hint">{f("privacy")}</p>
        <div>
          <SettingsButton variant="primary" disabled={busy || !rows || failed} onClick={() => void open()}>
            {f("create")}
          </SettingsButton>
        </div>
        {!rows && !failed ? <p role="status">{f("loading")}</p> : null}
        {failed ? (
          <p role="status">
            {f("failed")}{" "}
            <SettingsButton disabled={busy} onClick={() => void refresh()}>
              {f("retry")}
            </SettingsButton>
          </p>
        ) : null}
        {rows?.map((row) => {
          const a = row.assistant!;
          return (
            <div key={a.binding.botId} className="managed-bots__row">
              <CompanionAvatar id={a.actorId} />
              <div className="managed-bots__copy">
                <strong>{a.name}</strong>
                <small>
                  {a.paused
                    ? f("paused")
                    : a.environment?.kind === "sandbox"
                      ? (a.environment.backendId.startsWith("e2b-")
                          ? "E2B"
                          : a.environment.backendId.toLocaleUpperCase()) +
                        " · " +
                        a.environment.templateId
                      : f("local")}
                  {" · "}
                  {a.model?.modelId ?? f("noModel")}
                </small>
                {a.duties ? <p>{a.duties}</p> : null}
              </div>
              <div className="managed-bots__actions">
                <SettingsButton disabled={busy} onClick={() => void operate(row, "chat")}>
                  {f("chat")}
                </SettingsButton>
                <SettingsButton disabled={busy} onClick={() => void open(row)}>
                  {f("settings")}
                </SettingsButton>
                <SettingsButton variant="quiet" disabled={busy} onClick={() => void operate(row, "pause")}>
                  {f(a.paused ? "resume" : "pause")}
                </SettingsButton>
              </div>
            </div>
          );
        })}
        {rows?.length === 0 ? <p className="managed-bots__hint">{f("empty")}</p> : null}
        <span role="status">{feedback}</span>
        {error && !editor ? <p role="alert">{error}</p> : null}
        {editor ? (
          <Dialog.Root
            open
            onOpenChange={(o) => {
              if (!o) close();
            }}
          >
            <ModalContent
              className="managed-bots__dialog"
              onEscapeKeyDown={(e) => {
                if (busy) e.preventDefault();
              }}
              onInteractOutside={(e) => {
                if (busy) e.preventDefault();
              }}
            >
              <SettingsPanel
                title={
                  <Dialog.Title asChild>
                    <span>{f(editor.status ? "settings" : "create")}</span>
                  </Dialog.Title>
                }
                footer={
                  <>
                    <SettingsButton disabled={busy} onClick={close}>
                      {f("cancel")}
                    </SettingsButton>
                    <SettingsButton
                      variant="primary"
                      disabled={busy || !editor.name.trim() || !catalog}
                      loading={busy}
                      onClick={() => void commit()}
                    >
                      {f(editor.status ? "save" : "create")}
                    </SettingsButton>
                  </>
                }
              >
                <Dialog.Description>{f("privacy")}</Dialog.Description>
                {editor.status ? <p className="managed-bots__hint">{f("settingsImpact")}</p> : null}
                <SettingsGroup>
                  <SettingsRow layout="stacked" controlWidth="wide" label={f("name")}>
                    <SettingsTextInput
                      aria-label={f("name")}
                      value={editor.name}
                      maxLength={80}
                      disabled={busy}
                      onChange={(e) => setEditor({ ...editor, name: e.currentTarget.value })}
                    />
                  </SettingsRow>
                  <SettingsRow layout="stacked" controlWidth="wide" label={f("duties")}>
                    <SettingsTextInput
                      aria-label={f("duties")}
                      value={editor.duties}
                      maxLength={2000}
                      disabled={busy}
                      onChange={(e) => setEditor({ ...editor, duties: e.currentTarget.value })}
                    />
                  </SettingsRow>
                  <SettingsRow
                    layout="stacked"
                    controlWidth="wide"
                    label={f("environment")}
                    description={f(editor.environment.kind === "sandbox" ? "sandboxHint" : "localHint")}
                  >
                    <SettingsChoiceSelect
                      label={f("environment")}
                      value={environmentValue}
                      disabled={busy || !catalog}
                      options={[
                        { value: "local", label: f("local") },
                        ...(catalog?.templates ?? []).map((t) => ({
                          value: JSON.stringify([t.backendId, t.id]),
                          label:
                            (t.backendId.startsWith("e2b-") ? "E2B" : t.backendId.toLocaleUpperCase()) + " · " + t.name,
                        })),
                      ]}
                      onValueChange={(v) =>
                        setEditor({
                          ...editor,
                          environment:
                            v === "local"
                              ? { kind: "local" }
                              : { kind: "sandbox", backendId: JSON.parse(v)[0], templateId: JSON.parse(v)[1] },
                        })
                      }
                    />
                  </SettingsRow>
                  {editor.status?.assistant ? (
                    <SettingsRow layout="stacked" controlWidth="wide" label={f("model")}>
                      <SettingsChoiceSelect
                        label={f("model")}
                        value={
                          editor.status.assistant.model
                            ? JSON.stringify([
                                editor.status.assistant.model.providerId,
                                editor.status.assistant.model.modelId,
                              ])
                            : ""
                        }
                        disabled={busy || !models?.available}
                        options={[
                          { value: "", label: f("chooseModel") },
                          ...(models?.models ?? []).map((m) => ({
                            value: JSON.stringify([m.providerId, m.modelId]),
                            label: m.label,
                          })),
                        ]}
                        onValueChange={(v) => void selectModel(v)}
                      />
                    </SettingsRow>
                  ) : null}
                </SettingsGroup>
                {catalog && !catalog.templates.length ? (
                  <p className="managed-bots__hint">{f("e2bUnavailable")}</p>
                ) : null}
                {editor.status?.assistant ? (
                  <AssistantThreadSettings
                    rpc={rpc}
                    botId={editor.status.assistant.binding.botId}
                    reportError={() => setError(f("failed"))}
                  />
                ) : null}
                {editor.status?.assistant ? (
                  <SettingsButton disabled={busy} onClick={() => setMemory(editor.status)}>
                    {f("memory")}
                  </SettingsButton>
                ) : null}
                {error ? (
                  <p role="alert">
                    {error}{" "}
                    <SettingsButton disabled={busy} onClick={() => void open(editor.status, editor)}>
                      {f("retry")}
                    </SettingsButton>
                  </p>
                ) : null}
              </SettingsPanel>
            </ModalContent>
          </Dialog.Root>
        ) : null}
        {memory?.assistant ? (
          <Dialog.Root
            open
            onOpenChange={(o) => {
              if (!o && (!memoryGuard.current || memoryGuard.current())) setMemory(undefined);
            }}
          >
            <ModalContent className="managed-bots__memory">
              <Dialog.Title>
                {memory.assistant.name} · {f("memory")}
              </Dialog.Title>
              <Dialog.Description>{f("privacy")}</Dialog.Description>
              <AssistantMemory
                rpc={rpc}
                binding={memory.assistant.binding}
                registerCloseGuard={(g) => {
                  memoryGuard.current = g;
                  return () => {
                    if (memoryGuard.current === g) memoryGuard.current = null;
                  };
                }}
              />
              <SettingsButton
                onClick={() => {
                  if (!memoryGuard.current || memoryGuard.current()) setMemory(undefined);
                }}
              >
                {f("close")}
              </SettingsButton>
            </ModalContent>
          </Dialog.Root>
        ) : null}
      </div>
    </SettingsSection>
  );
}
