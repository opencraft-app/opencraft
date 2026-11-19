import "./git-credentials.scss";
import { SettingsCollectionSection } from "@opencraft/extension-react/settings-collection";
import { AssetDetails } from "../../../assets/details";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useIntl } from "react-intl";
import { useEffect, useId, useRef, useState } from "react";
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
import {
  GIT_CREDENTIALS_PATH,
  GIT_HOSTS,
  type EmployeeGitHost,
  type EmployeeGitInput,
  type EmployeeGitSnapshot,
  type EmployeeGitStatus,
} from "./git-credentials-contract";

const errors: Record<string, string> = {
  conflict: "配置已被其他操作更新。请加载最新配置后再编辑。",
  account_changed: "员工身份已变化，请重新打开设置。",
  github_account_mismatch: "令牌所属 GitHub 账号与填写的账号不一致。",
  github_email_unverified:
    "请填写该 GitHub 账号已验证的邮箱，或使用带账号 ID 的 noreply 邮箱。",
  github_email_permission_required:
    "读取已验证邮箱需要邮箱权限，也可使用带账号 ID 的 noreply 邮箱。",
  github_token_invalid: "GitHub 令牌无效或已过期，请更换。",
  github_permission_required:
    "令牌缺少签名密钥权限，可复制公钥到 GitHub 手动注册。",
  github_unavailable: "暂时无法连接 GitHub，请稍后重试。",
  invalid: "请检查账号、姓名、邮箱和令牌。",
  unavailable: "凭据服务暂时不可用，请重试。",
  taihu_token_invalid: "太湖令牌格式不正确，请从「创建令牌」复制完整令牌。",
  git_username_invalid: "请检查提交账号。",
  git_name_invalid: "请检查提交姓名。",
  git_email_invalid: "请填写有效的提交邮箱。",
};
const registrationLabels = {
  unregistered: "未注册",
  pending: "等待验证",
  registered: "已注册",
  manual_required: "需要手动注册",
};

/** This component is remounted at the verified account boundary; drafts never enter persistence. */
export function useEmployeeGitCredentials({
  scope,
  onUnauthorized,
  fetcher,
}: {
  scope: string;
  onUnauthorized(): void;
  fetcher: typeof fetch;
}) {
  const [snapshot, setSnapshot] = useState<EmployeeGitSnapshot | null>(null),
    [operationErrors, setOperationErrors] = useState<Record<string, string>>(
      {},
    );
  const [operationCodes, setOperationCodes] = useState<Record<string, string>>(
    {},
  );
  const [busy, setBusy] = useState(false),
    [unauthorized, setUnauthorized] = useState(false);
  const snapshotRef = useRef<EmployeeGitSnapshot | null>(null);
  const operations = useRef(new Set<AbortController>()),
    generation = useRef(0),
    latestRequests = useRef(new Map<string, number>());
  const load = async (input?: EmployeeGitInput) => {
    const keyOperation =
      input?.action === "generate-ssh" || input?.action === "delete-ssh";
    const namespace = input
      ? `${input.host}:${keyOperation ? "ssh" : input.action.endsWith("-mcp") ? "mcp" : "credentials"}`
      : "read";
    const epoch = generation.current,
      requestId = (latestRequests.current.get(namespace) ?? 0) + 1;
    latestRequests.current.set(namespace, requestId);
    const reportError = (message: string, code = "") => {
      if (
        generation.current === epoch &&
        latestRequests.current.get(namespace) === requestId
      ) {
        setOperationCodes((previous) => ({ ...previous, [namespace]: code }));
        setOperationErrors((previous) => ({
          ...previous,
          [namespace]: message,
        }));
      }
    };
    const abort = new AbortController();
    operations.current.add(abort);
    setBusy(true);
    reportError("");
    const timer = setTimeout(() => abort.abort(), 30_000);
    try {
      const response = await fetcher(GIT_CREDENTIALS_PATH, {
        method: input ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: abort.signal,
        headers: {
          "x-opencraft-account-scope": scope,
          ...(input ? { "content-type": "application/json" } : {}),
        },
        ...(input ? { body: JSON.stringify(input) } : {}),
      });
      if (generation.current !== epoch || abort.signal.aborted) return false;
      if (response.status === 401 || response.status === 403) {
        snapshotRef.current = null;
        setSnapshot(null);
        setUnauthorized(true);
        onUnauthorized();
        return false;
      }
      const body = await response.json();
      if (generation.current !== epoch || abort.signal.aborted) return false;
      if (!response.ok) {
        reportError(
          errors[body?.error] ?? errors.unavailable!,
          body?.error ?? "unavailable",
        );
        return false;
      }
      if (
        body?.scope !== scope ||
        !body.hosts ||
        !GIT_HOSTS.every(
          (host) =>
            Number.isSafeInteger(body.hosts[host]?.revision) &&
            typeof body.hosts[host]?.configured === "boolean",
        )
      )
        throw new Error();
      const previous = snapshotRef.current;
      const next: EmployeeGitSnapshot = previous
        ? {
            ...body,
            gongfengMcp:
              previous.gongfengMcp.revision > body.gongfengMcp.revision
                ? previous.gongfengMcp
                : body.gongfengMcp,
            hosts: Object.fromEntries(
              GIT_HOSTS.map((host) => [
                host,
                previous.hosts[host].revision > body.hosts[host].revision
                  ? previous.hosts[host]
                  : body.hosts[host],
              ]),
            ) as EmployeeGitSnapshot["hosts"],
          }
        : body;
      snapshotRef.current = next;
      setSnapshot(next);
      return true;
    } catch {
      reportError(errors.unavailable!);
      return false;
    } finally {
      clearTimeout(timer);
      operations.current.delete(abort);
      if (generation.current === epoch) setBusy(operations.current.size > 0);
    }
  };
  useEffect(() => {
    void load();
    return () => {
      ++generation.current;
      for (const operation of operations.current) operation.abort();
      operations.current.clear();
    };
  }, [scope]);
  return {
    snapshot,
    busy,
    unauthorized,
    operationErrors,
    operationCodes,
    clearHostErrors(host: EmployeeGitHost) {
      setOperationErrors((previous) =>
        Object.fromEntries(
          Object.entries(previous).filter(
            ([key]) => !key.startsWith(host + ":"),
          ),
        ),
      );
      setOperationCodes((previous) =>
        Object.fromEntries(
          Object.entries(previous).filter(
            ([key]) => !key.startsWith(host + ":"),
          ),
        ),
      );
    },
    load,
    getSnapshot: () => snapshotRef.current,
  };
}
export type EmployeeGitCredentialsController = ReturnType<
  typeof useEmployeeGitCredentials
>;

/** Assets reuses the same scoped request owner and existing mutation forms. */
export function EmployeeGitConnectionForm({
  controller,
  host,
  onDraftChange,
}: {
  controller: EmployeeGitCredentialsController;
  host: EmployeeGitHost;
  onDraftChange?: (dirty: boolean) => void;
}) {
  const { snapshot, busy, unauthorized, operationErrors, load } = controller;
  if (unauthorized)
    return (
      <SettingsNotice tone="error">
        员工身份已失效，请刷新身份后重新打开设置。
      </SettingsNotice>
    );
  return (
    <>
      <CredentialCard
        key={host}
        host={host}
        status={snapshot?.hosts[host] ?? null}
        mcp={snapshot?.gongfengMcp ?? null}
        busy={busy}
        error={Object.entries(operationErrors)
          .filter(([namespace]) => namespace.startsWith(host + ":"))
          .map(([, error]) => error)
          .filter(Boolean)
          .join(" ")}
        conflict={Object.entries(controller.operationCodes).some(
          ([key, code]) => key.startsWith(host + ":") && code === "conflict",
        )}
        reload={async () => {
          if (!(await load())) return false;
          controller.clearHostErrors(host);
          return true;
        }}
        readError={operationErrors.read ?? ""}
        save={load}
        readSnapshot={controller.getSnapshot}
        onDraftChange={onDraftChange}
      />
      {operationErrors.read ? (
        <SettingsNotice tone="error">{operationErrors.read}</SettingsNotice>
      ) : null}
    </>
  );
}

function CredentialCard({
  host,
  status,
  mcp,
  busy,
  error,
  save,
  reload,
  conflict,
  readError,
  readSnapshot,
  onDraftChange,
}: {
  host: EmployeeGitHost;
  status: EmployeeGitStatus | null;
  mcp: EmployeeGitSnapshot["gongfengMcp"] | null;
  busy: boolean;
  error: string;
  save(input: EmployeeGitInput): Promise<boolean>;
  reload(): Promise<boolean>;
  conflict: boolean;
  readError: string;
  readSnapshot(): EmployeeGitSnapshot | null;
  onDraftChange?: (dirty: boolean) => void;
}) {
  const intl = useIntl(),
    id = useId(),
    clearTrigger = useRef<HTMLButtonElement>(null),
    reloadTrigger = useRef<HTMLButtonElement>(null);
  const f = (key: string) =>
    intl.formatMessage({ id: "ioa.credentials." + key });
  const [confirmReload, setConfirmReload] = useState(false);
  const [clearProgress, setClearProgress] = useState({
    identity: false,
    mcp: false,
  });
  const clearPlan = useRef<{
    identity: boolean;
    mcp: boolean;
    identityRevision: number;
    mcpRevision: number;
    identityDone: boolean;
    mcpDone: boolean;
  } | null>(null);
  const [username, setUsername] = useState(""),
    [name, setName] = useState(""),
    [email, setEmail] = useState("");
  const [token, setToken] = useState(""),
    [taihuToken, setTaihuToken] = useState("");
  const [pending, setPending] = useState(false),
    [confirmClear, setConfirmClear] = useState(false),
    [copied, setCopied] = useState(false),
    [saveSucceeded, setSaveSucceeded] = useState(false);
  const [baseline, setBaseline] = useState<{
    status: EmployeeGitStatus;
    mcp: EmployeeGitSnapshot["gongfengMcp"] | null;
  } | null>(null);
  const autoRef = useRef({ name: "", email: "" });
  const dirty =
    !!token ||
    !!taihuToken ||
    (!!baseline &&
      (username !== (baseline.status.identity?.username ?? "") ||
        name !== (baseline.status.identity?.name ?? "") ||
        email !== (baseline.status.identity?.email ?? "")));
  useEffect(() => {
    if (!status || dirty || pending) return;
    setUsername(status.identity?.username ?? "");
    setName(status.identity?.name ?? "");
    setEmail(status.identity?.email ?? "");
    setBaseline({ status, mcp });
    autoRef.current = { name: "", email: "" };
  }, [status?.revision, mcp?.revision, dirty, pending]);
  useEffect(() => {
    onDraftChange?.(dirty);
  }, [dirty, onDraftChange]);
  useEffect(() => () => onDraftChange?.(false), [onDraftChange]);
  const acknowledge = (part: "identity" | "mcp") => {
    const next = readSnapshot();
    if (!next) return;
    if (part === "identity") {
      setUsername(next.hosts[host].identity?.username ?? "");
      setName(next.hosts[host].identity?.name ?? "");
      setEmail(next.hosts[host].identity?.email ?? "");
    }
    setBaseline((previous) => ({
      status:
        part === "identity"
          ? next.hosts[host]
          : (previous?.status ?? next.hosts[host]),
      mcp:
        part === "mcp" ? next.gongfengMcp : (previous?.mcp ?? next.gongfengMcp),
    }));
  };
  const onUsernameChange = (nextUsername: string) => {
    setSaveSucceeded(false);
    setUsername(nextUsername);
    if (host === "git.woa.com" && !status?.identity) {
      const trimmed = nextUsername.trim(),
        nextAutoEmail = trimmed ? `${trimmed}@tencent.com` : "";
      if (!name.trim() || name === autoRef.current.name) {
        setName(trimmed);
        autoRef.current.name = trimmed;
      }
      if (!email.trim() || email === autoRef.current.email) {
        setEmail(nextAutoEmail);
        autoRef.current.email = nextAutoEmail;
      }
    }
  };
  const disabled = busy || pending;
  const hasIdentityDraft = !!(username.trim() || name.trim() || email.trim());
  const completeIdentity = !!(username.trim() && name.trim() && email.trim());
  const unavailableReason = disabled
    ? ""
    : !status
      ? "读取失败，请刷新重试"
      : host === "git.woa.com" && taihuToken.trim() && mcp
        ? ""
        : !username.trim()
          ? "请填写账号"
          : !name.trim()
            ? "请填写提交姓名"
            : !email.trim()
              ? "请填写提交邮箱"
              : host === "github.com" && !token && !status.tokenConfigured
                ? "请填写个人访问令牌"
                : "";
  const submit = async () => {
    if (!status || disabled || unavailableReason) return;
    setPending(true);
    setSaveSucceeded(false);
    const personal = token,
      taihu = taihuToken;
    try {
      if (
        host === "github.com" ||
        completeIdentity ||
        (hasIdentityDraft && !taihu.trim())
      ) {
        const saved = await save({
          host,
          revision: baseline?.status.revision ?? status.revision,
          action: "save",
          username: username.trim(),
          name: name.trim(),
          email: email.trim(),
          ...(personal ? { token: personal } : {}),
        });
        if (saved) {
          acknowledge("identity");
          setToken((value) => (value === personal ? "" : value));
        } else return;
      }
      if (host === "git.woa.com" && taihu.trim() && mcp) {
        const saved = await save({
          host,
          revision: baseline?.mcp?.revision ?? mcp.revision,
          action: "save-mcp",
          token: taihu.trim(),
        });
        if (saved) {
          acknowledge("mcp");
          setTaihuToken((value) => (value === taihu ? "" : value));
        } else return;
      }
      setSaveSucceeded(true);
    } finally {
      setPending(false);
    }
  };
  const loadLatest = async () => {
    if (disabled) return;
    setPending(true);
    try {
      if (!(await reload())) return;
      const next = readSnapshot();
      if (!next) return;
      const latest = next.hosts[host];
      setUsername(latest.identity?.username ?? "");
      setName(latest.identity?.name ?? "");
      setEmail(latest.identity?.email ?? "");
      setToken("");
      setTaihuToken("");
      setBaseline({ status: latest, mcp: next.gongfengMcp });
      autoRef.current = { name: "", email: "" };
      setSaveSucceeded(false);
      setConfirmReload(false);
    } finally {
      setPending(false);
    }
  };
  const clear = async () => {
    const plan = clearPlan.current;
    if (!status || disabled || !plan) return;
    setPending(true);
    setSaveSucceeded(false);
    try {
      if (plan.identity && !plan.identityDone) {
        if (
          !(await save({
            host,
            revision: plan.identityRevision,
            action: "clear",
          }))
        )
          return;
        plan.identityDone = true;
        setClearProgress((progress) => ({ ...progress, identity: true }));
        acknowledge("identity");
      }
      if (plan.mcp && !plan.mcpDone) {
        if (
          !(await save({
            host,
            revision: plan.mcpRevision,
            action: "clear-mcp",
          }))
        )
          return;
        plan.mcpDone = true;
        setClearProgress((progress) => ({ ...progress, mcp: true }));
        acknowledge("mcp");
      }
      setToken("");
      setTaihuToken("");
      setConfirmClear(false);
      clearPlan.current = null;
    } finally {
      setPending(false);
    }
  };

  const tokenControl = (
    fieldId: string,
    value: string,
    update: (value: string) => void,
    saved: boolean,
    url: string,
  ) => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--gap-control-group)",
        width: "100%",
        flexWrap: "wrap",
      }}
    >
      <SettingsTextInput
        id={fieldId}
        style={{ flex: "1 1 12rem", minWidth: 0 }}
        type="password"
        autoComplete="new-password"
        placeholder={saved ? "已保存；留空保留原令牌" : undefined}
        value={value}
        disabled={disabled || !status}
        onChange={(event) => {
          setSaveSucceeded(false);
          update(event.target.value);
        }}
      />
      <a
        style={{ color: "var(--color-text-accent)" }}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
      >
        创建令牌
      </a>
    </div>
  );
  const configured =
    !!status &&
    (status.configured ||
      !!status.sshAuth ||
      (host === "git.woa.com" && !!mcp?.configured));
  return (
    <SettingsSection
      className="employee-git-credentials-card"
      title={host === "github.com" ? "GitHub 连接" : "工蜂连接"}
      description={host === "git.woa.com" ? "代码访问与工具访问分别配置，按需启用。" : "让助理访问你的代码仓库。"}
      action={host === "git.woa.com" ? undefined :
        <span className="employee-git-credentials-card__status">
          {status ? (configured ? "已添加" : "未添加") : "正在读取"}
        </span>
      }
      aria-busy={disabled}
    >
      <form
        className="employee-git-credentials-card__form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <SettingsCollectionSection
          title={intl.formatMessage({
            id: "assets.accountInfo",
            defaultMessage: "Account information",
          })}
        >
          <SettingsGroup>
            <SettingsRow
              layout="stacked"
              label="账号"
              htmlFor={`${id}-username`}
            >
              <SettingsTextInput
                id={`${id}-username`}
                autoComplete="off"
                value={username}
                disabled={!status || disabled}
                onChange={(event) => onUsernameChange(event.target.value)}
              />
            </SettingsRow>
            <SettingsRow
              layout="stacked"
              label="提交姓名"
              htmlFor={`${id}-name`}
            >
              <SettingsTextInput
                id={`${id}-name`}
                autoComplete="off"
                value={name}
                disabled={!status || disabled}
                onChange={(event) => {
                  setSaveSucceeded(false);
                  setName(event.target.value);
                }}
              />
            </SettingsRow>
            <SettingsRow
              layout="stacked"
              label="提交邮箱"
              htmlFor={`${id}-email`}
            >
              <SettingsTextInput
                id={`${id}-email`}
                type="email"
                autoComplete="off"
                value={email}
                disabled={!status || disabled}
                onChange={(event) => {
                  setSaveSucceeded(false);
                  setEmail(event.target.value);
                }}
              />
            </SettingsRow>
          </SettingsGroup>
        </SettingsCollectionSection>
        {host === "git.woa.com" ? (
          <SettingsCollectionSection title="代码访问（Git）">
            <SettingsGroup>
              <SettingsRow label="SSH 配置" description="用于拉取和推送代码。工具访问令牌不能用于 Git 命令。">
                {status ? (status.sshAuth ? "密钥已生成，连接尚未验证" : "未配置 SSH 密钥") : "正在读取"}
              </SettingsRow>
            <GongfengSshField
              status={status}
              busy={disabled}
              identity={{
                username: username.trim(),
                name: name.trim(),
                email: email.trim(),
              }}
              save={save}
            />
            </SettingsGroup>
          </SettingsCollectionSection>
        ) : null}
        <SettingsCollectionSection
          title={host === "git.woa.com" ? "工具访问（MCP）" : intl.formatMessage({
            id: "assets.accessCredentials",
            defaultMessage: "Access credentials",
          })}
        >
          <SettingsGroup>
            {host === "github.com" ? (
              <SettingsRow
                layout="stacked"
                label="个人访问令牌"
                htmlFor={`${id}-token`}
              >
                {tokenControl(
                  `${id}-token`,
                  token,
                  setToken,
                  !!status?.tokenConfigured,
                  "https://github.com/settings/tokens/new?scopes=repo,write:ssh_signing_key,user:email&description=Join%20Git%20credentials",
                )}
              </SettingsRow>
            ) : (
              <SettingsRow
                layout="stacked"
                label={intl.formatMessage({
                  id: "ioa.credentials.taihuToken",
                  defaultMessage: "Tools access token",
                })}
                htmlFor={`${id}-taihu`}
                description={mcp ? (mcp.configured ? "令牌已保存。用于工蜂工具调用，不提供 Git 拉取和推送权限。" : "未配置。使用工蜂工具时需要；仅使用 Git 无需填写。") : "正在读取"}
              >
                {tokenControl(
                  `${id}-taihu`,
                  taihuToken,
                  setTaihuToken,
                  !!mcp?.configured,
                  "https://tai.it.woa.com/user/pat",
                )}
              </SettingsRow>
            )}
          </SettingsGroup>
        </SettingsCollectionSection>
        <SettingsActions
          className="employee-git-credentials-card__actions"
          align="start"
          wrap
        >
          <SettingsButton
            variant="primary"
            disabled={disabled || !!unavailableReason}
            aria-describedby={
              unavailableReason || error ? `${id}-save-status` : undefined
            }
            type="submit"
          >
            {pending
              ? intl.formatMessage({
                  id: "ioa.credentials.saving",
                  defaultMessage: "Saving…",
                })
              : "保存连接"}
          </SettingsButton>
          {conflict ? (
            <SettingsButton
              type="button"
              variant="quiet"
              disabled={disabled}
              onClick={(event) => {
                reloadTrigger.current = event.currentTarget;
                setConfirmReload(true);
              }}
            >
              {f("loadLatest")}
            </SettingsButton>
          ) : null}
          <span id={`${id}-save-status`} role={error ? "alert" : "status"}>
            {error ||
              (pending
                ? intl.formatMessage({
                    id: "ioa.credentials.saving",
                    defaultMessage: "Saving…",
                  })
                : saveSucceeded && !dirty
                  ? intl.formatMessage({
                      id: "ioa.credentials.saved",
                      defaultMessage: "Saved.",
                    })
                  : dirty || !status
                    ? unavailableReason
                    : "")}
          </span>
        </SettingsActions>
      </form>
      <AssetDetails
        label={
          host === "github.com" &&
          status?.signing?.registration === "manual_required"
            ? "更多设置 · 需要完成验证"
            : "更多设置"
        }
      >
        <SettingsGroup appearance="plain">
          {host === "github.com" ? (
            <>
              <SettingsRow layout="stacked" label="提交验证">
                {status?.signing
                  ? registrationLabels[status.signing.registration]
                  : "添加连接后自动设置"}
              </SettingsRow>
              {status?.signing ? (
                <>
                  <SettingsRow layout="stacked" label="签名指纹">
                    <span style={{ overflowWrap: "anywhere" }}>
                      {status.signing.fingerprint}
                    </span>
                  </SettingsRow>
                  <SettingsRow
                    layout="stacked"
                    label="签名公钥"
                    htmlFor={`${id}-public`}
                  >
                    <div className="employee-git-credentials-card__keyline">
                      <SettingsTextInput
                        id={`${id}-public`}
                        readOnly
                        value={status.signing.publicKey}
                      />
                      <SettingsButton
                        disabled={disabled}
                        onClick={() => {
                          void navigator.clipboard
                            .writeText(status.signing!.publicKey)
                            .then(() => setCopied(true))
                            .catch(() => setCopied(false));
                        }}
                      >
                        {copied ? "已复制公钥" : "复制签名公钥"}
                      </SettingsButton>
                      <SettingsButton
                        disabled={disabled}
                        onClick={() => {
                          void save({
                            host,
                            revision: status.revision,
                            action: "register",
                          });
                        }}
                      >
                        重试验证
                      </SettingsButton>
                    </div>
                  </SettingsRow>
                </>
              ) : null}
            </>
          ) : null}
        </SettingsGroup>
        {host === "github.com" &&
        status?.signing?.registration === "manual_required" ? (
          <SettingsNotice>
            请在 GitHub 的 SSH and GPG keys 中添加上方公钥，类型选择 Signing
            Key；也可以更新令牌的签名权限后重试。
          </SettingsNotice>
        ) : null}
        <SettingsActions align="start">
          <SettingsButton
            variant="danger"
            disabled={
              disabled ||
              !status ||
              (!status.identity && !(host === "git.woa.com" && mcp?.configured))
            }
            onClick={(event) => {
              clearTrigger.current = event.currentTarget;
              clearPlan.current = {
                identity: !!status?.identity,
                mcp: host === "git.woa.com" && !!mcp?.configured,
                identityRevision: baseline?.status.revision ?? status!.revision,
                mcpRevision: baseline?.mcp?.revision ?? mcp?.revision ?? 0,
                identityDone: false,
                mcpDone: false,
              };
              setClearProgress({ identity: false, mcp: false });
              setConfirmClear(true);
            }}
          >
            解除绑定
          </SettingsButton>
        </SettingsActions>
      </AssetDetails>
      <AlertDialog.Root
        open={confirmClear}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirmClear(false);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay
            className="modal-surface__scrim"
            data-layer="confirmation"
            data-appearance="utility"
          />
          <AlertDialog.Content
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const trigger = clearTrigger.current;
              if (trigger?.disabled)
                trigger.ownerDocument.getElementById(`${id}-username`)?.focus();
              else trigger?.focus();
            }}
            className="modal-surface"
            data-layer="confirmation"
            data-appearance="utility"
            data-size="compact"
          >
            <SettingsPanel
              title={
                <AlertDialog.Title asChild>
                  <span>解除绑定</span>
                </AlertDialog.Title>
              }
              footer={
                <>
                  <AlertDialog.Cancel asChild>
                    <SettingsButton disabled={pending}>
                      {intl.formatMessage({
                        id: "ioa.ssh.cancel",
                        defaultMessage: "Cancel",
                      })}
                    </SettingsButton>
                  </AlertDialog.Cancel>
                  <SettingsButton
                    variant="danger"
                    disabled={pending}
                    onClick={() => {
                      void clear();
                    }}
                  >
                    {intl.formatMessage({
                      id: "ioa.credentials.confirmDeleteSsh",
                      defaultMessage: "Confirm deletion",
                    })}
                  </SettingsButton>
                </>
              }
            >
              {clearProgress.identity ? (
                <p role="status">{f("identityRemoved")}</p>
              ) : null}
              {clearProgress.mcp ? (
                <p role="status">{f("toolsRemoved")}</p>
              ) : null}
              {error ? (
                <SettingsNotice tone="error">{error}</SettingsNotice>
              ) : null}
              {error && (clearProgress.identity || clearProgress.mcp) ? (
                <p>{f("unbindRemaining")}</p>
              ) : null}
              <AlertDialog.Description>
                {host === "github.com"
                  ? "解除本地绑定后，GitHub 上的密钥和令牌需自行撤销。"
                  : intl.formatMessage({
                      id: "ioa.credentials.gongfengUnbindAbout",
                      defaultMessage:
                        "Remove the Gongfeng identity, SSH private key and tools token stored in OpenCraft. Repositories are not deleted. Keys and tokens on Gongfeng or Taihu are not revoked; revoke them at those services if needed.",
                    })}
              </AlertDialog.Description>
            </SettingsPanel>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      <AlertDialog.Root
        open={confirmReload}
        onOpenChange={(open) => {
          if (!pending) setConfirmReload(open);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay
            className="modal-surface__scrim"
            data-layer="confirmation"
            data-appearance="utility"
          />
          <AlertDialog.Content
            className="modal-surface"
            data-layer="confirmation"
            data-appearance="utility"
            data-size="compact"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              (
                reloadTrigger.current?.isConnected
                  ? reloadTrigger.current
                  : document.getElementById(`${id}-username`)
              )?.focus();
            }}
          >
            <SettingsPanel
              title={
                <AlertDialog.Title asChild>
                  <span>{f("loadLatestTitle")}</span>
                </AlertDialog.Title>
              }
              footer={
                <>
                  <AlertDialog.Cancel asChild>
                    <SettingsButton disabled={pending}>
                      {intl.formatMessage({ id: "ioa.ssh.cancel" })}
                    </SettingsButton>
                  </AlertDialog.Cancel>
                  <SettingsButton
                    variant="primary"
                    disabled={pending}
                    onClick={() => void loadLatest()}
                  >
                    {pending ? f("loadingLatest") : f("loadLatest")}
                  </SettingsButton>
                </>
              }
            >
              <AlertDialog.Description>
                {f("loadLatestAbout")}
              </AlertDialog.Description>
              {readError ? (
                <SettingsNotice tone="error">{readError}</SettingsNotice>
              ) : null}
            </SettingsPanel>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </SettingsSection>
  );
}

function GongfengSshField({
  status,
  busy,
  identity,
  save,
}: {
  status: EmployeeGitStatus | null;
  busy: boolean;
  identity: { username: string; name: string; email: string };
  save(input: EmployeeGitInput): Promise<boolean>;
}) {
  const intl = useIntl(),
    id = useId(),
    lastTrigger = useRef<HTMLButtonElement | null>(null);
  const [pending, setPending] = useState(false),
    [copied, setCopied] = useState(false);
  const [confirmation, setConfirmation] = useState<
    "generate-ssh" | "delete-ssh" | null
  >(null);
  useEffect(() => {
    setCopied(false);
    setConfirmation(null);
  }, [status?.sshAuth?.generation]);
  const key = status?.sshAuth;
  const act = async (action: "generate-ssh" | "delete-ssh") => {
    if (!status || busy || pending) return;
    setPending(true);
    try {
      await save({
        host: "git.woa.com",
        revision: status.revision,
        action,
        ...(action === "generate-ssh" ? identity : {}),
      });
    } finally {
      setPending(false);
      setConfirmation(null);
    }
  };
  return (
    <SettingsRow
      label={intl.formatMessage({
        id: "ioa.credentials.sshKey",
        defaultMessage: "SSH key",
      })}
      htmlFor={key ? id : undefined}
      description={intl.formatMessage({
        id: "ioa.credentials.sshHelp",
        defaultMessage:
          "Add the public key to your Gongfeng account to push as yourself.",
      })}
    >
      <div
        style={{
          display: "grid",
          width: "100%",
          gap: "var(--gap-control-group)",
        }}
        aria-busy={pending}
      >
        <div className="employee-git-credentials-card__keyline">
          {key ? (
            <>
              <SettingsTextInput id={id} readOnly value={key.publicKey} />
              <SettingsButton
                type="button"
                disabled={pending}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(key.publicKey)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false));
                }}
              >
                {copied
                  ? intl.formatMessage({
                      id: "ioa.ssh.copied",
                      defaultMessage: "Copied",
                    })
                  : intl.formatMessage({
                      id: "ioa.credentials.copyPublicKey",
                      defaultMessage: "Copy public key",
                    })}
              </SettingsButton>
            </>
          ) : null}
          <a
            className="employee-git-credentials-card__keylink"
            href="https://git.woa.com/profile/keys"
            target="_blank"
            rel="noopener noreferrer"
          >
            {intl.formatMessage({
              id: "ioa.credentials.addSsh",
              defaultMessage: "Add SSH key",
            })}
          </a>
        </div>
        <SettingsActions align="start" wrap>
          <SettingsButton
                type="button"
            id={`${id}-generate`}
            disabled={
              !status ||
              busy ||
              pending ||
              (!status.identity &&
                (!identity.username || !identity.name || !identity.email))
            }
            onClick={(event) => {
              lastTrigger.current = event.currentTarget;
              if (key) setConfirmation("generate-ssh");
              else void act("generate-ssh");
            }}
          >
            {key
              ? intl.formatMessage({
                  id: "ioa.ssh.regenerate",
                  defaultMessage: "Regenerate key",
                })
              : intl.formatMessage({
                  id: "ioa.ssh.generate",
                  defaultMessage: "Generate SSH key",
                })}
          </SettingsButton>
          {key ? (
            <SettingsButton
                type="button"
              variant="danger"
              disabled={busy || pending}
              onClick={(event) => {
                lastTrigger.current = event.currentTarget;
                setConfirmation("delete-ssh");
              }}
            >
              {intl.formatMessage({
                id: "ioa.credentials.deleteSsh",
                defaultMessage: "Delete key",
              })}
            </SettingsButton>
          ) : null}
        </SettingsActions>
        <AlertDialog.Root
          open={confirmation !== null}
          onOpenChange={(open) => {
            if (!open && !pending) setConfirmation(null);
          }}
        >
          <AlertDialog.Portal>
            <AlertDialog.Overlay
              className="modal-surface__scrim"
              data-layer="confirmation"
              data-appearance="utility"
            />
            <AlertDialog.Content
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                if (lastTrigger.current?.isConnected)
                  lastTrigger.current.focus();
                else
                  lastTrigger.current?.ownerDocument
                    .getElementById(`${id}-generate`)
                    ?.focus();
              }}
              className="modal-surface"
              data-layer="confirmation"
              data-appearance="utility"
              data-size="compact"
            >
              <SettingsPanel
                title={
                  <AlertDialog.Title asChild>
                    <span>
                      {confirmation === "generate-ssh"
                        ? intl.formatMessage({
                            id: "ioa.ssh.confirm",
                            defaultMessage: "Confirm regeneration",
                          })
                        : intl.formatMessage({
                            id: "ioa.credentials.confirmDeleteSsh",
                            defaultMessage: "Confirm deletion",
                          })}
                    </span>
                  </AlertDialog.Title>
                }
                footer={
                  <>
                    <AlertDialog.Cancel asChild>
                      <SettingsButton disabled={pending}>
                        {intl.formatMessage({
                          id: "ioa.ssh.cancel",
                          defaultMessage: "Cancel",
                        })}
                      </SettingsButton>
                    </AlertDialog.Cancel>
                    <SettingsButton
                type="button"
                      variant="danger"
                      disabled={pending}
                      onClick={() => {
                        if (confirmation) void act(confirmation);
                      }}
                    >
                      {confirmation === "generate-ssh"
                        ? intl.formatMessage({
                            id: "ioa.ssh.confirm",
                            defaultMessage: "Confirm regeneration",
                          })
                        : intl.formatMessage({
                            id: "ioa.credentials.confirmDeleteSsh",
                            defaultMessage: "Confirm deletion",
                          })}
                    </SettingsButton>
                  </>
                }
              >
                <AlertDialog.Description>
                  {intl.formatMessage({
                    id: "ioa.credentials.sshHelp",
                    defaultMessage:
                      "Add the public key to your Gongfeng account to push as yourself.",
                  })}
                </AlertDialog.Description>
              </SettingsPanel>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      </div>
    </SettingsRow>
  );
}
