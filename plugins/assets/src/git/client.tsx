import "./view.scss";
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
import type { AssetConnections } from "../ports.js";
import type { AssetProvider } from "../providers.js";
import type { GitConnectionInput, GitConnectionsSnapshot, GitProviderDescriptor } from "./contract.js";
import { parseGitConnections } from "./contract.js";
import { useGitConnectionController, type GitConnectionController } from "./controller.js";
import { gitMessages, sshGitMessages, type GitMessage } from "./messages.js";
import { SshConnectionForm } from "./ssh-form.js";
export { useGitConnectionController } from "./controller.js";
const HOST = "github.com";
const ENDPOINT = "/__opencraft_assets/git-connections";
const GITHUB_ONLY: readonly GitProviderDescriptor[] = [{ host: HOST, auth: "token" }];
export const githubAssetProvider = {
  id: "github",
  name: "GitHub",
  capabilities: ["git"],
  editor: "git",
  host: HOST,
  about: { id: "assets.git.description", defaultMessage: gitMessages.description },
} as const;
/** Catalog rows for the advertised providers this client has an editor for:
 * GitHub's token flow and any configured SSH-key host. */
export function gitAssetProviders(providers: readonly GitProviderDescriptor[]): AssetProvider[] {
  return providers.flatMap((p): AssetProvider[] =>
    p.auth === "ssh"
      ? [
          {
            id: "git-ssh:" + p.host,
            name: p.name,
            capabilities: ["git"],
            editor: "git",
            host: p.host,
            about: sshGitMessages.about,
          },
        ]
      : p.host === HOST
        ? [githubAssetProvider]
        : [],
  );
}
function useMessages() {
  const intl = useIntl();
  return (key: GitMessage) => intl.formatMessage({ id: "assets.git." + key, defaultMessage: gitMessages[key] });
}
export type { GitConnectionController };
export type GithubConnectionController = GitConnectionController;
/** One metadata controller for every advertised Git host; each host keeps its own
 * revision, pending namespace and editor. */
export function useGitAssetConnections(
  fetcher: typeof fetch,
  scope: string,
  onUnauthorized: () => void,
  providers: readonly GitProviderDescriptor[],
): AssetConnections {
  const f = useMessages();
  const hosts = providers.map((p) => p.host);
  const controller = useGitConnectionController<GitConnectionsSnapshot, GitConnectionInput>({
    scope,
    fetcher,
    onUnauthorized,
    endpoint: ENDPOINT,
    parse: (raw, scope) => parseGitConnections(raw, scope, hosts),
    errorText: (code) => f(Object.hasOwn(gitMessages, code) ? (code as GitMessage) : "unavailable"),
  });
  return {
    available: !!controller.snapshot,
    busy: controller.busy,
    unauthorized: controller.unauthorized,
    readError: controller.operationErrors.read,
    configured: (host) => hosts.includes(host) && !!controller.snapshot?.hosts[host]?.configured,
    description: (host) => (hosts.includes(host) ? (controller.snapshot?.hosts[host]?.identity?.username ?? "") : ""),
    load: async () => {
      await controller.load();
    },
    renderEditor: (host, onDraftChange) => {
      const provider = providers.find((p) => p.host === host);
      if (provider?.auth === "ssh")
        return <SshConnectionForm controller={controller} provider={provider} onDraftChange={onDraftChange} />;
      return provider?.host === HOST ? (
        <GithubConnectionForm controller={controller} onDraftChange={onDraftChange} />
      ) : null;
    },
  };
}
export function useGithubAssetConnections(
  fetcher: typeof fetch,
  scope: string,
  onUnauthorized: () => void,
): AssetConnections {
  return useGitAssetConnections(fetcher, scope, onUnauthorized, GITHUB_ONLY);
}
/** One draft, pinned expected revision and secret input. Refresh never overwrites
 * an edited draft, failed/unknown writes are not replayed, and clear/reload are explicit. */
export function GithubConnectionForm({
  controller,
  onDraftChange,
}: {
  controller: GithubConnectionController;
  onDraftChange?: (dirty: boolean) => void;
}) {
  const f = useMessages(),
    id = useId();
  const status = controller.snapshot?.hosts[HOST] ?? null;
  const [draft, setDraft] = useState({ username: "", name: "", email: "", token: "" }),
    [baseline, setBaseline] = useState<typeof status>(null),
    [pending, setPending] = useState(false),
    [saved, setSaved] = useState(false),
    [dialog, setDialog] = useState<"clear" | "reload" | null>(null),
    [copied, setCopied] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null),
    clearRevision = useRef<number | null>(null);
  const dirty =
    !!draft.token ||
    (!!baseline &&
      (draft.username !== (baseline.identity?.username ?? "") ||
        draft.name !== (baseline.identity?.name ?? "") ||
        draft.email !== (baseline.identity?.email ?? "")));
  const disabled = pending || controller.busy || controller.unauthorized;
  const error = Object.entries(controller.operationErrors)
    .filter(([key]) => key.startsWith(HOST + ":"))
    .map(([, v]) => v)
    .filter(Boolean)
    .join(" ");
  const conflict = Object.entries(controller.operationCodes).some(
    ([key, code]) => key.startsWith(HOST + ":") && code === "conflict",
  );
  const readError = controller.operationErrors.read ?? "";
  // An open dialog owns the feedback for its action (see SshConnectionForm).
  const feedback = [dialog ? "" : readError, error].filter(Boolean).join(" ");
  const dialogError = dialog === "reload" ? readError || error : error || readError;
  function adopt(row: NonNullable<typeof status>) {
    setBaseline(row);
    setDraft({
      username: row.identity?.username ?? "",
      name: row.identity?.name ?? "",
      email: row.identity?.email ?? "",
      token: "",
    });
  }
  useEffect(() => {
    if (status && !dirty && !pending) adopt(status);
  }, [status?.revision, dirty, pending]);
  useEffect(() => {
    onDraftChange?.(dirty);
  }, [dirty, onDraftChange]);
  useEffect(() => () => onDraftChange?.(false), [onDraftChange]);
  const reason = !status
    ? f("unavailable")
    : !draft.username.trim()
      ? f("usernameRequired")
      : !draft.name.trim()
        ? f("nameRequired")
        : !draft.email.trim()
          ? f("emailRequired")
          : !draft.token && !status.tokenConfigured
            ? f("tokenRequired")
            : "";
  function edit(key: keyof typeof draft, value: string) {
    setSaved(false);
    setDraft((d) => ({ ...d, [key]: value }));
  }
  async function submit() {
    if (disabled || reason || !status) return;
    setPending(true);
    setSaved(false);
    try {
      if (
        await controller.load({
          host: HOST,
          revision: baseline?.revision ?? status.revision,
          action: "save",
          username: draft.username.trim(),
          name: draft.name.trim(),
          email: draft.email.trim(),
          ...(draft.token ? { token: draft.token } : {}),
        })
      ) {
        const row = controller.getSnapshot()?.hosts[HOST];
        if (row) adopt(row);
        setSaved(true);
      }
    } finally {
      setPending(false);
    }
  }
  async function confirm() {
    if (disabled) return;
    setPending(true);
    try {
      if (dialog === "clear") {
        if (clearRevision.current === null) return;
        if (!(await controller.load({ host: HOST, revision: clearRevision.current, action: "clear" }))) return;
      } else {
        if (!(await controller.load())) return;
        controller.clearHostErrors(HOST);
      }
      const row = controller.getSnapshot()?.hosts[HOST];
      if (row) adopt(row);
      setDialog(null);
      setSaved(false);
    } finally {
      setPending(false);
    }
  }
  if (controller.unauthorized) return <SettingsNotice tone="error">{f("forbidden")}</SettingsNotice>;
  return (
    <SettingsSection
      className="git-connection"
      title={f("title")}
      description={f("description")}
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
          void submit();
        }}
      >
        <SettingsCollectionSection title={f("accountInfo")}>
          <SettingsGroup>
            {(["username", "name", "email"] as const).map((key) => (
              <SettingsRow key={key} layout="stacked" label={f(key)} htmlFor={id + "-" + key}>
                <SettingsTextInput
                  id={id + "-" + key}
                  type={key === "email" ? "email" : "text"}
                  autoComplete="off"
                  disabled={disabled || !status}
                  value={draft[key]}
                  onChange={(e) => edit(key, e.target.value)}
                />
              </SettingsRow>
            ))}
          </SettingsGroup>
        </SettingsCollectionSection>
        <SettingsCollectionSection title={f("accessCredentials")}>
          <SettingsGroup>
            <SettingsRow layout="stacked" label={f("token")} htmlFor={id + "-token"}>
              <div className="git-connection__keyline">
                <SettingsTextInput
                  id={id + "-token"}
                  type="password"
                  autoComplete="new-password"
                  disabled={disabled || !status}
                  value={draft.token}
                  placeholder={status?.tokenConfigured ? f("savedToken") : undefined}
                  onChange={(e) => edit("token", e.target.value)}
                />
                <a
                  className="git-connection__keylink"
                  href="https://github.com/settings/tokens/new?scopes=repo,write:ssh_signing_key,user:email&description=OpenCraft%20Git%20connection"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {f("createToken")}
                </a>
              </div>
            </SettingsRow>
          </SettingsGroup>
        </SettingsCollectionSection>
        <SettingsActions align="start" wrap>
          <SettingsButton
            variant="primary"
            type="submit"
            disabled={disabled || !!reason || !dirty}
            aria-describedby={id + "-status"}
          >
            {f(pending ? "saving" : "save")}
          </SettingsButton>
          {conflict ? (
            <SettingsButton
              disabled={disabled}
              onClick={(e) => {
                trigger.current = e.currentTarget;
                setDialog("reload");
              }}
            >
              {f("loadLatest")}
            </SettingsButton>
          ) : null}
          <span id={id + "-status"} role={feedback ? "alert" : "status"}>
            {feedback || (saved && !dirty ? f("saved") : dirty || !status ? reason : "")}
          </span>
        </SettingsActions>
      </form>
      <AssetDetails label={f(status?.signing?.registration === "manual_required" ? "verificationNeeded" : "more")}>
        <SettingsGroup appearance="plain">
          <SettingsRow layout="stacked" label={f("verification")}>
            {status?.signing ? f(status.signing.registration) : f("afterSave")}
          </SettingsRow>
          {status?.signing ? (
            <>
              <SettingsRow layout="stacked" label={f("fingerprint")}>
                <span style={{ overflowWrap: "anywhere" }}>{status.signing.fingerprint}</span>
              </SettingsRow>
              <SettingsRow layout="stacked" label={f("publicKey")} htmlFor={id + "-public"}>
                <div className="git-connection__keyline">
                  <SettingsTextInput id={id + "-public"} readOnly value={status.signing.publicKey} />
                  <SettingsButton
                    disabled={disabled}
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(status.signing!.publicKey)
                        .then(() => setCopied(true))
                        .catch(() => setCopied(false));
                    }}
                  >
                    {f(copied ? "copied" : "copy")}
                  </SettingsButton>
                  <SettingsButton
                    disabled={disabled}
                    onClick={() => {
                      void controller.load({ host: HOST, revision: status.revision, action: "register" });
                    }}
                  >
                    {f("retry")}
                  </SettingsButton>
                </div>
              </SettingsRow>
            </>
          ) : null}
        </SettingsGroup>
        {status?.signing?.registration === "manual_required" ? <SettingsNotice>{f("manual")}</SettingsNotice> : null}
        <SettingsActions align="start">
          <SettingsButton
            variant="danger"
            disabled={disabled || !status?.identity}
            onClick={(e) => {
              trigger.current = e.currentTarget;
              clearRevision.current = baseline?.revision ?? status?.revision ?? null;
              setDialog("clear");
            }}
          >
            {f("clear")}
          </SettingsButton>
        </SettingsActions>
      </AssetDetails>
      <AlertDialog.Root
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setDialog(null);
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
              else document.getElementById(id + "-username")?.focus();
            }}
          >
            <SettingsPanel
              title={
                <AlertDialog.Title asChild>
                  <span>{f(dialog === "clear" ? "clear" : "loadLatestTitle")}</span>
                </AlertDialog.Title>
              }
              footer={
                <>
                  <AlertDialog.Cancel asChild>
                    <SettingsButton disabled={pending}>{f("cancel")}</SettingsButton>
                  </AlertDialog.Cancel>
                  <SettingsButton
                    variant={dialog === "clear" ? "danger" : "primary"}
                    disabled={pending}
                    onClick={() => {
                      void confirm();
                    }}
                  >
                    {f(dialog === "clear" ? "confirmClear" : pending ? "loadingLatest" : "loadLatest")}
                  </SettingsButton>
                </>
              }
            >
              <AlertDialog.Description>
                {f(dialog === "clear" ? "clearAbout" : "loadLatestAbout")}
              </AlertDialog.Description>
              {dialogError ? <SettingsNotice tone="error">{dialogError}</SettingsNotice> : null}
            </SettingsPanel>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </SettingsSection>
  );
}
