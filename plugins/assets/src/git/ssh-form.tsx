import { useEffect, useId, useRef, useState } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useIntl } from "@opencraft/i18n/react";
import {
  SettingsActions,
  SettingsButton,
  SettingsPanel,
  SettingsGroup,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
  SettingsTextInput,
} from "@opencraft/extension-react";
import { SettingsCollectionSection } from "@opencraft/extension-react/settings-collection";
import { AssetDetails } from "../details.js";
import type { GitConnectionStatus, GitProviderDescriptor } from "./contract.js";
import type { GitConnectionController } from "./controller.js";
import { gitMessages, sshGitMessages, type GitMessage, type SshGitMessage } from "./messages.js";

type SshProvider = Extract<GitProviderDescriptor, { auth: "ssh" }>;
type Action = "save" | "generate-ssh" | "delete-ssh" | "clear" | "reload";
type Dialog = "regenerate" | "delete" | "clear" | "reload";

/** Settings editor for a Git host that authenticates with a key generated on the
 * server. Only the public key and fingerprint are ever in this component; the
 * private key stays in the vault. One identity draft is pinned to its expected
 * revision; key actions are explicit, confirmed when destructive and never replayed. */
export function SshConnectionForm({
  controller,
  provider,
  onDraftChange,
}: {
  controller: GitConnectionController;
  provider: SshProvider;
  onDraftChange?: (dirty: boolean) => void;
}) {
  const intl = useIntl(),
    id = useId(),
    host = provider.host,
    values = { name: provider.name };
  const f = (key: GitMessage) => intl.formatMessage({ id: "assets.git." + key, defaultMessage: gitMessages[key] });
  const s = (key: SshGitMessage) => intl.formatMessage(sshGitMessages[key], values);
  const status = controller.snapshot?.hosts[host] ?? null,
    key = status?.sshAuth ?? null;
  const [draft, setDraft] = useState({ username: "", name: "", email: "" }),
    [baseline, setBaseline] = useState<GitConnectionStatus | null>(null),
    [pending, setPending] = useState<Action | null>(null),
    [saved, setSaved] = useState(false),
    [dialog, setDialog] = useState<Dialog | null>(null),
    [copied, setCopied] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null),
    dialogRevision = useRef<number | null>(null);
  const dirty =
    !!baseline &&
    (draft.username !== (baseline.identity?.username ?? "") ||
      draft.name !== (baseline.identity?.name ?? "") ||
      draft.email !== (baseline.identity?.email ?? ""));
  const disabled = pending !== null || controller.busy || controller.unauthorized;
  const prefix = host + ":";
  const error = Object.entries(controller.operationErrors)
    .filter(([k, v]) => k.startsWith(prefix) && v)
    .map(([k, v]) => (controller.operationCodes[k] === "invalid" ? s("invalid") : v))
    .join(" ");
  const conflict = Object.entries(controller.operationCodes).some(
    ([k, code]) => k.startsWith(prefix) && code === "conflict",
  );
  function adopt(row: GitConnectionStatus) {
    setBaseline(row);
    setDraft({
      username: row.identity?.username ?? "",
      name: row.identity?.name ?? "",
      email: row.identity?.email ?? "",
    });
  }
  useEffect(() => {
    if (status && !dirty && pending === null) adopt(status);
  }, [status?.revision, dirty, pending]);
  useEffect(() => {
    onDraftChange?.(dirty);
  }, [dirty, onDraftChange]);
  useEffect(() => () => onDraftChange?.(false), [onDraftChange]);
  // A new or removed key retires the copy confirmation of the previous one.
  useEffect(() => setCopied(false), [key?.generation]);
  const identity = { username: draft.username.trim(), name: draft.name.trim(), email: draft.email.trim() };
  const reason = !status
    ? f("unavailable")
    : !identity.username
      ? s("usernameRequired")
      : !identity.name
        ? f("nameRequired")
        : !identity.email
          ? f("emailRequired")
          : "";
  const expected = () => baseline?.revision ?? status?.revision ?? null;
  function edit(field: keyof typeof draft, value: string) {
    setSaved(false);
    setDraft((d) => ({ ...d, [field]: value }));
  }
  async function run(action: Action, revision: number | null) {
    if (disabled || !status) return false;
    setPending(action);
    setSaved(false);
    try {
      let ok: boolean;
      if (action === "reload") {
        ok = await controller.load();
        if (ok) controller.clearHostErrors(host);
      } else if (revision === null) ok = false;
      // A generated key is stored with the current draft identity in one write.
      else if (action === "save" || action === "generate-ssh")
        ok = await controller.load({ host, revision, action, ...identity });
      else ok = await controller.load({ host, revision, action });
      if (ok) {
        const row = controller.getSnapshot()?.hosts[host];
        if (row) adopt(row);
        if (action === "save") setSaved(true);
      }
      return ok;
    } finally {
      setPending(null);
    }
  }
  function open(next: Dialog, button: HTMLButtonElement) {
    trigger.current = button;
    dialogRevision.current = expected();
    setDialog(next);
  }
  async function confirm() {
    if (!dialog) return;
    const action: Action =
      dialog === "regenerate"
        ? "generate-ssh"
        : dialog === "delete"
          ? "delete-ssh"
          : dialog === "clear"
            ? "clear"
            : "reload";
    if (await run(action, dialogRevision.current)) setDialog(null);
  }
  if (controller.unauthorized) return <SettingsNotice tone="error">{f("forbidden")}</SettingsNotice>;
  const dialogCopy: Record<Dialog, { title: string; about: string; confirm: string; danger: boolean }> = {
    regenerate: {
      title: s("regenerateTitle"),
      about: s("regenerateAbout"),
      confirm: pending === "generate-ssh" ? s("generating") : s("confirmRegenerate"),
      danger: true,
    },
    delete: { title: s("deleteTitle"), about: s("deleteAbout"), confirm: s("confirmDelete"), danger: true },
    clear: { title: f("clear"), about: s("clearAbout"), confirm: f("confirmClear"), danger: true },
    reload: {
      title: f("loadLatestTitle"),
      about: f("loadLatestAbout"),
      confirm: pending === "reload" ? f("loadingLatest") : f("loadLatest"),
      danger: false,
    },
  };
  const copy = dialog ? dialogCopy[dialog] : null;
  // Before a key exists, generating it is the primary task and also stores the
  // identity; afterwards identity edits are saved on their own.
  const hint = error
    ? error
    : saved && !dirty
      ? f("saved")
      : status && reason && (dirty || !key)
        ? key
          ? reason
          : s("identityRequired")
        : "";
  return (
    <SettingsSection
      className="git-connection"
      title={s("title")}
      description={s("description")}
      aria-busy={disabled}
      action={
        <span className="git-connection__status">
          {!status ? f("loading") : status.configured ? f("added") : f("notAdded")}
        </span>
      }
    >
      <form
        className="git-connection__form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (key && !reason && dirty) void run("save", expected());
        }}
      >
        <SettingsCollectionSection title={f("accountInfo")}>
          <SettingsGroup>
            {(["username", "name", "email"] as const).map((field) => (
              <SettingsRow key={field} layout="stacked" label={f(field)} htmlFor={id + "-" + field}>
                <SettingsTextInput
                  id={id + "-" + field}
                  type={field === "email" ? "email" : "text"}
                  autoComplete="off"
                  disabled={disabled || !status}
                  value={draft[field]}
                  onChange={(e) => edit(field, e.target.value)}
                />
              </SettingsRow>
            ))}
          </SettingsGroup>
        </SettingsCollectionSection>
        <SettingsCollectionSection title={s("key")}>
          <SettingsGroup>
            <SettingsRow label={s("status")}>
              <span>{!status ? f("loading") : key ? s("keyReady") : s("noKey")}</span>
            </SettingsRow>
            {key ? (
              <>
                <SettingsRow layout="stacked" label={s("publicKey")} htmlFor={id + "-public"}>
                  <div className="git-connection__keyline">
                    <SettingsTextInput id={id + "-public"} readOnly value={key.publicKey} />
                    <SettingsButton
                      type="button"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(key.publicKey)
                          .then(() => setCopied(true))
                          .catch(() => setCopied(false));
                      }}
                    >
                      {s(copied ? "copied" : "copy")}
                    </SettingsButton>
                  </div>
                </SettingsRow>
                <SettingsRow layout="stacked" label={s("fingerprint")}>
                  <span style={{ overflowWrap: "anywhere" }}>{key.fingerprint}</span>
                </SettingsRow>
              </>
            ) : null}
          </SettingsGroup>
        </SettingsCollectionSection>
        <SettingsActions align="start" wrap>
          {key ? (
            <SettingsButton
              variant="primary"
              type="submit"
              disabled={disabled || !!reason || !dirty}
              aria-describedby={id + "-status"}
            >
              {f(pending === "save" ? "saving" : "save")}
            </SettingsButton>
          ) : null}
          <SettingsButton
            id={id + "-generate"}
            type="button"
            variant={key ? "secondary" : "primary"}
            disabled={disabled || !!reason}
            aria-describedby={id + "-status"}
            onClick={(e) => {
              if (key) open("regenerate", e.currentTarget);
              else void run("generate-ssh", expected());
            }}
          >
            {pending === "generate-ssh" ? s("generating") : key ? s("regenerate") : s("generate")}
          </SettingsButton>
          {conflict ? (
            <SettingsButton type="button" disabled={disabled} onClick={(e) => open("reload", e.currentTarget)}>
              {f("loadLatest")}
            </SettingsButton>
          ) : null}
          <span id={id + "-status"} role={error ? "alert" : "status"}>
            {hint}
          </span>
        </SettingsActions>
      </form>
      <AssetDetails label={f("more")}>
        <SettingsActions align="start" wrap>
          {key ? (
            <SettingsButton
              type="button"
              variant="danger"
              disabled={disabled}
              onClick={(e) => open("delete", e.currentTarget)}
            >
              {s("delete")}
            </SettingsButton>
          ) : null}
          <SettingsButton
            type="button"
            variant="danger"
            disabled={disabled || !status?.identity}
            onClick={(e) => open("clear", e.currentTarget)}
          >
            {f("clear")}
          </SettingsButton>
        </SettingsActions>
      </AssetDetails>
      <AlertDialog.Root
        open={dialog !== null}
        onOpenChange={(next) => {
          if (!next && pending === null) setDialog(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="modal-surface__scrim" data-layer="confirmation" data-appearance="utility" />
          <AlertDialog.Content
            className="modal-surface"
            data-layer="confirmation"
            data-appearance="utility"
            data-size="compact"
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              const button = trigger.current;
              if (button?.isConnected && !button.disabled) button.focus();
              else document.getElementById(id + "-generate")?.focus();
            }}
          >
            <SettingsPanel
              title={
                <AlertDialog.Title asChild>
                  <span>{copy?.title}</span>
                </AlertDialog.Title>
              }
              footer={
                <>
                  <AlertDialog.Cancel asChild>
                    <SettingsButton disabled={pending !== null}>{f("cancel")}</SettingsButton>
                  </AlertDialog.Cancel>
                  <SettingsButton
                    variant={copy?.danger ? "danger" : "primary"}
                    disabled={pending !== null}
                    onClick={() => {
                      void confirm();
                    }}
                  >
                    {copy?.confirm}
                  </SettingsButton>
                </>
              }
            >
              <AlertDialog.Description>{copy?.about}</AlertDialog.Description>
              {error || controller.operationErrors.read ? (
                <SettingsNotice tone="error">{error || controller.operationErrors.read}</SettingsNotice>
              ) : null}
            </SettingsPanel>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      {controller.operationErrors.read ? (
        <SettingsNotice tone="error">{controller.operationErrors.read}</SettingsNotice>
      ) : null}
    </SettingsSection>
  );
}
