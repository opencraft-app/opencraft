import "./ssh-keys-settings.scss";
import { useCallback, useEffect, useRef, useState } from "react";
import { defineMessages, type MessageDescriptor } from "@opencraft/i18n";
import { useIntl } from "@opencraft/i18n/react";
import {
  SettingsActions,
  SettingsButton,
  SettingsGroup,
  SettingsListItem,
  SettingsNotice,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsTextInput,
} from "@opencraft/extension-react";
import { serverFetch } from "../runtime/server-context";
import { useOptionalAsyncNotices } from "./async-notices";

/** Personal SSH keys of the signed-in person (Headless `/__opencraft_ssh_keys`). */
export const SSH_KEYS_PATH = "/__opencraft_ssh_keys";

export interface SshKeyView {
  readonly id: string;
  readonly name: string;
  readonly algorithm: string;
  readonly fingerprint: string;
  readonly createdAt: number;
  readonly addedBy: "self" | "administrator" | "operator" | "import";
}
interface SshKeysState {
  readonly actorId: string;
  readonly sshLogin: boolean;
  readonly keys: readonly SshKeyView[];
}
type Phase = "loading" | "ready" | "error" | "expired" | "unavailable";

const messages = defineMessages({
  title: { id: "settings.sshKeys.title", defaultMessage: "SSH keys" },
  description: {
    id: "settings.sshKeys.description",
    defaultMessage: "Connect to this server over SSH with your own keys. Each key signs in as you.",
  },
  yours: { id: "settings.sshKeys.yours", defaultMessage: "Your keys" },
  yoursHint: {
    id: "settings.sshKeys.yoursHint",
    defaultMessage:
      "Any SSH user name works; the key identifies you. Removing a key ends the SSH sessions that use it.",
  },
  empty: { id: "settings.sshKeys.empty", defaultMessage: "No SSH keys yet" },
  emptyHint: {
    id: "settings.sshKeys.emptyHint",
    defaultMessage: "Add the public key of each device you connect from.",
  },
  added: { id: "settings.sshKeys.added", defaultMessage: "{algorithm} · Added {date}" },
  addedByAdministrator: {
    id: "settings.sshKeys.addedByAdministrator",
    defaultMessage: "{algorithm} · Added {date} by an administrator",
  },
  addedByImport: { id: "settings.sshKeys.addedByImport", defaultMessage: "{algorithm} · Added {date} by import" },
  remove: { id: "settings.sshKeys.remove", defaultMessage: "Remove" },
  removeLabel: { id: "settings.sshKeys.removeLabel", defaultMessage: "Remove {name}" },
  removeFailed: {
    id: "settings.sshKeys.removeFailed",
    defaultMessage: "The key could not be removed. Reload the page and try again.",
  },
  add: { id: "settings.sshKeys.add", defaultMessage: "Add a key" },
  addHint: {
    id: "settings.sshKeys.addHint",
    defaultMessage: "Paste one public key, such as the contents of ~/.ssh/id_ed25519.pub. Never paste a private key.",
  },
  publicKey: { id: "settings.sshKeys.publicKey", defaultMessage: "Public key" },
  keyPlaceholder: { id: "settings.sshKeys.keyPlaceholder", defaultMessage: "ssh-ed25519 AAAA… you@device" },
  name: { id: "settings.sshKeys.name", defaultMessage: "Name" },
  nameHint: { id: "settings.sshKeys.nameHint", defaultMessage: "Optional. The key comment is used when empty." },
  namePlaceholder: { id: "settings.sshKeys.namePlaceholder", defaultMessage: "Work laptop" },
  submit: { id: "settings.sshKeys.submit", defaultMessage: "Add key" },
  loading: { id: "settings.sshKeys.loading", defaultMessage: "Loading your SSH keys…" },
  loadFailed: { id: "settings.sshKeys.loadFailed", defaultMessage: "Your SSH keys could not be loaded." },
  reload: { id: "settings.sshKeys.reload", defaultMessage: "Reload" },
  expired: {
    id: "settings.sshKeys.expired",
    defaultMessage: "Your account changed or expired. Sign in again and reopen this page.",
  },
  unavailable: {
    id: "settings.sshKeys.unavailable",
    defaultMessage: "This server does not support personal SSH keys.",
  },
  loginDisabled: {
    id: "settings.sshKeys.loginDisabled",
    defaultMessage:
      "This server does not accept SSH connections yet. Keys you add take effect once an administrator enables SSH access.",
  },
  invalidKey: {
    id: "settings.sshKeys.invalidKey",
    defaultMessage: "Enter one OpenSSH public key: Ed25519, ECDSA or RSA of at least 2048 bits.",
  },
  invalidName: { id: "settings.sshKeys.invalidName", defaultMessage: "Use a shorter name without line breaks." },
  keyExists: { id: "settings.sshKeys.keyExists", defaultMessage: "This key is already in your list." },
  keyInUse: {
    id: "settings.sshKeys.keyInUse",
    defaultMessage: "This key belongs to another person on this server. Use a key of your own.",
  },
  keyLimit: {
    id: "settings.sshKeys.keyLimit",
    defaultMessage: "You have reached the key limit. Remove a key you no longer use first.",
  },
  addFailed: {
    id: "settings.sshKeys.addFailed",
    defaultMessage: "The key could not be added. Your input is kept; try again.",
  },
});

const ADD_ERRORS: Record<string, MessageDescriptor> = {
  invalid_ssh_key: messages.invalidKey,
  invalid_key_name: messages.invalidName,
  key_exists: messages.keyExists,
  key_in_use: messages.keyInUse,
  key_limit: messages.keyLimit,
};

function parseState(value: unknown): SshKeysState {
  const input = value as Partial<SshKeysState> | null;
  if (!input || typeof input.actorId !== "string" || typeof input.sshLogin !== "boolean" || !Array.isArray(input.keys))
    throw Error("invalid_ssh_keys");
  for (const key of input.keys)
    if (
      !key ||
      typeof key.id !== "string" ||
      typeof key.name !== "string" ||
      typeof key.fingerprint !== "string" ||
      typeof key.algorithm !== "string" ||
      !Number.isFinite(key.createdAt)
    )
      throw Error("invalid_ssh_keys");
  return { actorId: input.actorId, sshLogin: input.sshLogin, keys: input.keys };
}

export function SshKeysSettings({ fetcher = serverFetch }: { fetcher?: typeof fetch }) {
  const intl = useIntl();
  const notices = useOptionalAsyncNotices();
  const [state, setState] = useState<SshKeysState | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [publicKey, setPublicKey] = useState("");
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<MessageDescriptor | null>(null);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const generation = useRef(0);
  const mounted = useRef(true);
  // StrictMode remounts: a remount is mounted again.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setPhase((previous) => (previous === "ready" ? "ready" : "loading"));
    try {
      const response = await fetcher(SSH_KEYS_PATH, { credentials: "same-origin", cache: "no-store" });
      if (!mounted.current || current !== generation.current) return;
      if (response.status === 401) {
        setState(null);
        setPhase("expired");
        return;
      }
      if (response.status === 404) {
        setState(null);
        setPhase("unavailable");
        return;
      }
      if (!response.ok) {
        setPhase("error");
        return;
      }
      const next = parseState(await response.json());
      if (!mounted.current || current !== generation.current) return;
      setState(next);
      setPhase("ready");
    } catch {
      if (mounted.current && current === generation.current) setPhase("error");
    }
  }, [fetcher]);
  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    if (!state || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      const response = await fetcher(SSH_KEYS_PATH, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicKey,
          ...(name.trim() ? { name: name.trim() } : {}),
          expectedActorId: state.actorId,
        }),
      });
      let value: { error?: string; key?: SshKeyView } | undefined;
      try {
        value = await response.json();
      } catch {
        /* A proxy may answer with HTML. */
      }
      if (!mounted.current) return;
      if (response.status === 401 || value?.error === "account_changed") {
        setState(null);
        setPhase("expired");
        return;
      }
      if (!response.ok || !value?.key) {
        setAddError(ADD_ERRORS[value?.error ?? ""] ?? messages.addFailed);
        return;
      }
      const key = value.key;
      setState(
        (previous) => previous && { ...previous, keys: [...previous.keys.filter((entry) => entry.id !== key.id), key] },
      );
      setPublicKey("");
      setName("");
    } catch {
      if (mounted.current) setAddError(messages.addFailed);
    } finally {
      if (mounted.current) setAdding(false);
    }
  };

  const remove = async (key: SshKeyView) => {
    if (!state || removing.has(key.id)) return;
    setRemoving((previous) => new Set(previous).add(key.id));
    try {
      const response = await fetcher(
        `${SSH_KEYS_PATH}/${encodeURIComponent(key.id)}?${new URLSearchParams({ expectedActorId: state.actorId })}`,
        { method: "DELETE", credentials: "same-origin", cache: "no-store" },
      );
      if (!mounted.current) return;
      if (response.status === 401 || response.status === 409) {
        setState(null);
        setPhase("expired");
        return;
      }
      if (!response.ok && response.status !== 404) throw Error("remove_failed");
      setState((previous) => previous && { ...previous, keys: previous.keys.filter((entry) => entry.id !== key.id) });
    } catch {
      if (mounted.current)
        notices?.error({
          key: `ssh-key-remove:${key.id}`,
          detail: key.name,
          message: intl.formatMessage(messages.removeFailed),
        });
    } finally {
      if (mounted.current)
        setRemoving((previous) => {
          const next = new Set(previous);
          next.delete(key.id);
          return next;
        });
    }
  };

  const added = (key: SshKeyView) =>
    intl.formatMessage(
      key.addedBy === "administrator"
        ? messages.addedByAdministrator
        : key.addedBy === "import"
          ? messages.addedByImport
          : messages.added,
      { algorithm: key.algorithm, date: intl.formatDate(key.createdAt, { dateStyle: "medium" }) },
    );

  return (
    <>
      <SettingsPageHeader
        title={intl.formatMessage(messages.title)}
        description={intl.formatMessage(messages.description)}
      />
      {phase === "expired" ? (
        <SettingsNotice role="alert" tone="error">
          {intl.formatMessage(messages.expired)}
        </SettingsNotice>
      ) : phase === "unavailable" ? (
        <SettingsNotice>{intl.formatMessage(messages.unavailable)}</SettingsNotice>
      ) : (
        <div className="ssh-keys-settings">
          {state && !state.sshLogin ? (
            <SettingsNotice>{intl.formatMessage(messages.loginDisabled)}</SettingsNotice>
          ) : null}
          <SettingsSection
            title={intl.formatMessage(messages.yours)}
            description={intl.formatMessage(messages.yoursHint)}
          >
            <SettingsGroup aria-busy={phase === "loading"}>
              {state === null ? (
                <SettingsListItem
                  className="ssh-keys-settings__placeholder"
                  label={intl.formatMessage(phase === "error" ? messages.loadFailed : messages.loading)}
                  actions={
                    phase === "error" ? (
                      <SettingsButton onClick={() => void load()}>{intl.formatMessage(messages.reload)}</SettingsButton>
                    ) : undefined
                  }
                />
              ) : state.keys.length === 0 ? (
                <SettingsListItem
                  label={intl.formatMessage(messages.empty)}
                  description={intl.formatMessage(messages.emptyHint)}
                />
              ) : (
                state.keys.map((key) => (
                  <SettingsListItem
                    key={key.id}
                    label={key.name}
                    description={
                      <span className="ssh-keys-settings__fingerprint" translate="no">
                        {key.fingerprint}
                      </span>
                    }
                    metadata={added(key)}
                    actions={
                      <SettingsButton
                        variant="danger"
                        loading={removing.has(key.id)}
                        disabled={removing.has(key.id)}
                        aria-label={intl.formatMessage(messages.removeLabel, { name: key.name })}
                        onClick={() => void remove(key)}
                      >
                        {intl.formatMessage(messages.remove)}
                      </SettingsButton>
                    }
                  />
                ))
              )}
            </SettingsGroup>
          </SettingsSection>
          <SettingsSection title={intl.formatMessage(messages.add)} description={intl.formatMessage(messages.addHint)}>
            <form
              className="ssh-keys-settings__form"
              aria-busy={adding}
              onSubmit={(event) => {
                event.preventDefault();
                void add();
              }}
            >
              <SettingsGroup>
                <SettingsRow layout="stacked" label={intl.formatMessage(messages.publicKey)} htmlFor="ssh-key-public">
                  <textarea
                    id="ssh-key-public"
                    className="settings-control-input ssh-keys-settings__key"
                    rows={3}
                    value={publicKey}
                    placeholder={intl.formatMessage(messages.keyPlaceholder)}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    translate="no"
                    disabled={!state || adding}
                    aria-invalid={addError === messages.invalidKey || undefined}
                    aria-describedby="ssh-key-error"
                    onChange={(event) => {
                      setPublicKey(event.currentTarget.value);
                      setAddError(null);
                    }}
                  />
                </SettingsRow>
                <SettingsRow
                  layout="stacked"
                  label={intl.formatMessage(messages.name)}
                  description={intl.formatMessage(messages.nameHint)}
                  htmlFor="ssh-key-name"
                >
                  <SettingsTextInput
                    id="ssh-key-name"
                    value={name}
                    maxLength={128}
                    autoComplete="off"
                    placeholder={intl.formatMessage(messages.namePlaceholder)}
                    disabled={!state || adding}
                    onChange={(event) => {
                      setName(event.currentTarget.value);
                      setAddError(null);
                    }}
                  />
                </SettingsRow>
              </SettingsGroup>
              <div id="ssh-key-error" className="ssh-keys-settings__error" role={addError ? "alert" : undefined}>
                {addError ? intl.formatMessage(addError) : null}
              </div>
              <SettingsActions>
                <SettingsButton
                  type="submit"
                  variant="primary"
                  loading={adding}
                  disabled={!state || adding || !publicKey.trim()}
                >
                  {intl.formatMessage(messages.submit)}
                </SettingsButton>
              </SettingsActions>
            </form>
          </SettingsSection>
        </div>
      )}
    </>
  );
}
