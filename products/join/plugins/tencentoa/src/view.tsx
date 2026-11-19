import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useIntl } from "react-intl";
import {
  SettingsActions,
  SettingsButton,
  SettingsGroup,
  SettingsNotice,
  SettingsPanel,
  SettingsRow,
  SettingsSection,
} from "@opencraft/extension-react";
import type { EmployeeSshCredential, TencentOaDiagnostic } from "./contract";
import type { TencentOaController } from "./controller";
import { AssetDetails } from "../../../assets/details";
import "./identity-view.scss";

async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* Permission or insecure-context failure falls back to selection copy. */
    }
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.style.position = "fixed";
  field.style.left = "-9999px";
  field.style.top = "0";
  document.body.appendChild(field);
  try {
    field.focus();
    field.select();
    if (!document.execCommand("copy")) throw new Error("Copy failed");
  } finally {
    field.remove();
  }
}

function diagnosticReason(diagnostic: TencentOaDiagnostic): string {
  return `原因：${[
    diagnostic.failureKind,
    diagnostic.httpStatus === null ? null : `HTTP ${diagnostic.httpStatus}`,
    diagnostic.serverReason,
  ]
    .filter((part): part is string => part !== null)
    .join(" / ")}`;
}

export function createEmployeeIdentityView(controller: TencentOaController) {
  return function EmployeeIdentityView() {
    const intl = useIntl();
    const snapshot = useSyncExternalStore(
      controller.subscribe,
      controller.getSnapshot,
      controller.getSnapshot,
    );
    const identity = snapshot.identity;
    const diagnostic = snapshot.diagnostic;
    const [copied, setCopied] = useState(false);
    const [showPrivateKey, setShowPrivateKey] = useState(false);
    const account = identity
      ? `${identity.staffId}:${identity.loginName}`
      : null;
    const [ssh, setSsh] = useState<{
      account: string;
      credential: EmployeeSshCredential | null;
      failed: boolean;
    } | null>(null);
    const [keyCopied, setKeyCopied] = useState(false);
    const [retry, setRetry] = useState(0);
    const [confirmRegenerate, setConfirmRegenerate] = useState(false);
    const [savingKey, setSavingKey] = useState(false);
    const [keyError, setKeyError] = useState(false);
    const keyRequest = useRef<AbortController | null>(null);
    useEffect(() => {
      setShowPrivateKey(false);
      setSsh(null);
      setKeyCopied(false);
      setConfirmRegenerate(false);
      setKeyError(false);
      setSavingKey(false);
      if (!account) return;
      const request = new AbortController();
      void controller
        .readSshCredential(request.signal)
        .then((credential) => {
          if (!request.signal.aborted)
            setSsh({ account, credential, failed: false });
        })
        .catch(() => {
          if (!request.signal.aborted)
            setSsh({ account, credential: null, failed: true });
        });
      return () => {
        request.abort();
        keyRequest.current?.abort();
        keyRequest.current = null;
      };
    }, [account, retry]);
    const currentSsh = account && ssh?.account === account ? ssh : null;
    const generateKey = async () => {
      if (!account || !currentSsh || currentSsh.failed || keyRequest.current)
        return;
      const request = new AbortController();
      keyRequest.current = request;
      setSavingKey(true);
      setKeyError(false);
      setKeyCopied(false);
      try {
        const credential = await controller.generateSshCredential(
          currentSsh.credential?.fingerprint ?? null,
          request.signal,
        );
        if (!request.signal.aborted) {
          setSsh({ account, credential, failed: false });
          setShowPrivateKey(false);
          setConfirmRegenerate(false);
        }
      } catch {
        if (!request.signal.aborted) {
          setKeyError(true);
          setConfirmRegenerate(false);
        }
      } finally {
        if (keyRequest.current === request) {
          keyRequest.current = null;
          setSavingKey(false);
        }
      }
    };
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
      () => () => {
        if (timer.current) clearTimeout(timer.current);
      },
      [],
    );
    const copy = () => {
      if (!diagnostic) return;
      const text = JSON.stringify(diagnostic, null, 2);
      void copyText(text)
        .then(() => {
          // Browser probes can assert the exact copied text without reading the clipboard.
          (globalThis as any).__lastCopiedTencentOaDiagnostic = text;
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 2000);
        })
        .catch(() => {
          /* Keep the original label when neither path can copy. */
        });
    };
    const showDiagnostic =
      snapshot.phase === "error" ||
      snapshot.available === false ||
      (!identity && diagnostic !== null);
    return (
      <SettingsPanel
        title={intl.formatMessage({
          id: "ioa.identity.developerOptions",
          defaultMessage: "Developer options",
        })}
      >
        <div className="employee-identity__content">
          {!identity ? (
            <SettingsSection
              title={intl.formatMessage({
                id: "ioa.ssh.title",
                defaultMessage: "SSH connection",
              })}
              action={
                <SettingsButton
                  variant="quiet"
                  disabled={snapshot.phase === "loading"}
                  onClick={() => void controller.refresh()}
                >
                  {intl.formatMessage({
                    id: "ioa.ssh.retry",
                    defaultMessage: "Retry",
                  })}
                </SettingsButton>
              }
            >
              {snapshot.phase === "error" || snapshot.available === false ? (
                <SettingsNotice tone="error">
                  暂时无法确认员工身份，请重试
                </SettingsNotice>
              ) : !identity ? (
                <SettingsNotice>暂未识别到员工身份，请刷新重试</SettingsNotice>
              ) : null}
              {showDiagnostic && diagnostic ? (
                <AssetDetails label="查看问题详情">
                  <p role="status">{diagnosticReason(diagnostic)}</p>
                  <SettingsActions align="start">
                    <SettingsButton type="button" onClick={copy}>
                      {copied ? "已复制" : "复制错误信息"}
                    </SettingsButton>
                  </SettingsActions>
                </AssetDetails>
              ) : null}
            </SettingsSection>
          ) : null}
          {identity ? (
            <SettingsSection
              title={intl.formatMessage({
                id: "ioa.ssh.title",
                defaultMessage: "SSH connection",
              })}
              description={intl.formatMessage({
                id: "ioa.ssh.description",
                defaultMessage:
                  "Connect using your employee username and private key. Keep your private key safe.",
              })}
              action={
                currentSsh?.credential ? (
                  <SettingsButton
                    disabled={savingKey}
                    onClick={() => {
                      const value = currentSsh.credential!.privateKey;
                      void copyText(value)
                        .then(() => setKeyCopied(true))
                        .catch(() => {});
                    }}
                  >
                    {keyCopied
                      ? intl.formatMessage({
                          id: "ioa.ssh.copied",
                          defaultMessage: "Copied",
                        })
                      : intl.formatMessage({
                          id: "ioa.ssh.copy",
                          defaultMessage: "Copy private key",
                        })}
                  </SettingsButton>
                ) : undefined
              }
            >
              {currentSsh?.credential ? (
                <>
                  <SettingsGroup>
                    <SettingsRow
                      label={intl.formatMessage({
                        id: "ioa.ssh.username",
                        defaultMessage: "Username",
                      })}
                    >
                      {currentSsh.credential.username}
                    </SettingsRow>
                    <SettingsRow
                      label={intl.formatMessage({
                        id: "ioa.ssh.fingerprint",
                        defaultMessage: "Key fingerprint",
                      })}
                      layout="stacked"
                    >
                      <span style={{ overflowWrap: "anywhere" }}>
                        {currentSsh.credential.fingerprint}
                      </span>
                    </SettingsRow>
                    {showPrivateKey ? (
                      <SettingsRow
                        label={intl.formatMessage({
                          id: "ioa.ssh.privateKey",
                          defaultMessage: "Private key",
                        })}
                        layout="stacked"
                      >
                        <pre
                          style={{
                            margin: 0,
                            whiteSpace: "pre-wrap",
                            overflowWrap: "anywhere",
                            userSelect: "text",
                          }}
                        >
                          {currentSsh.credential.privateKey}
                        </pre>
                      </SettingsRow>
                    ) : null}
                    <SettingsActions align="start">
                      <SettingsButton
                        onClick={() => setShowPrivateKey((value) => !value)}
                      >
                        {intl.formatMessage({
                          id: showPrivateKey
                            ? "ioa.ssh.hidePrivateKey"
                            : "ioa.ssh.showPrivateKey",
                          defaultMessage: showPrivateKey
                            ? "Hide private key"
                            : "Show private key",
                        })}
                      </SettingsButton>
                    </SettingsActions>
                  </SettingsGroup>
                </>
              ) : currentSsh?.failed ? (
                <SettingsNotice>
                  {intl.formatMessage({
                    id: "ioa.ssh.unavailable",
                    defaultMessage:
                      "Unable to load your SSH key. Please retry.",
                  })}
                </SettingsNotice>
              ) : (
                <SettingsNotice>
                  {currentSsh
                    ? intl.formatMessage({
                        id: "ioa.ssh.empty",
                        defaultMessage:
                          "No SSH key yet. Generate one to connect.",
                      })
                    : intl.formatMessage({
                        id: "ioa.ssh.loading",
                        defaultMessage: "Loading SSH key…",
                      })}
                </SettingsNotice>
              )}
              {keyError ? (
                <SettingsNotice>
                  {intl.formatMessage({
                    id: "ioa.ssh.generateFailed",
                    defaultMessage:
                      "Unable to generate the key. Reload and retry.",
                  })}
                </SettingsNotice>
              ) : null}
              {confirmRegenerate ? (
                <SettingsNotice>
                  {intl.formatMessage({
                    id: "ioa.ssh.confirmRegenerate",
                    defaultMessage:
                      "Regenerating invalidates your old key and disconnects connections using it. Continue?",
                  })}
                </SettingsNotice>
              ) : null}
              <SettingsActions align="start">
                {currentSsh && !currentSsh.failed ? (
                  confirmRegenerate ? (
                    <>
                      <SettingsButton
                        disabled={savingKey}
                        onClick={() => {
                          void generateKey();
                        }}
                      >
                        {savingKey
                          ? intl.formatMessage({
                              id: "ioa.ssh.generating",
                              defaultMessage: "Generating…",
                            })
                          : intl.formatMessage({
                              id: "ioa.ssh.confirm",
                              defaultMessage: "Confirm regeneration",
                            })}
                      </SettingsButton>
                      <SettingsButton
                        disabled={savingKey}
                        onClick={() => setConfirmRegenerate(false)}
                      >
                        {intl.formatMessage({
                          id: "ioa.ssh.cancel",
                          defaultMessage: "Cancel",
                        })}
                      </SettingsButton>
                    </>
                  ) : (
                    <SettingsButton
                      disabled={savingKey}
                      onClick={() => {
                        if (currentSsh.credential) setConfirmRegenerate(true);
                        else void generateKey();
                      }}
                    >
                      {savingKey
                        ? intl.formatMessage({
                            id: "ioa.ssh.generating",
                            defaultMessage: "Generating…",
                          })
                        : currentSsh.credential
                          ? intl.formatMessage({
                              id: "ioa.ssh.regenerate",
                              defaultMessage: "Regenerate key",
                            })
                          : intl.formatMessage({
                              id: "ioa.ssh.generate",
                              defaultMessage: "Generate SSH key",
                            })}
                    </SettingsButton>
                  )
                ) : null}
                {currentSsh?.failed || keyError ? (
                  <SettingsButton
                    disabled={savingKey}
                    onClick={() => setRetry((value) => value + 1)}
                  >
                    {intl.formatMessage({
                      id: "ioa.ssh.retry",
                      defaultMessage: "Retry",
                    })}
                  </SettingsButton>
                ) : null}
              </SettingsActions>
            </SettingsSection>
          ) : null}
        </div>
      </SettingsPanel>
    );
  };
}
