import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { SettingsButton, SettingsNotice, SettingsPanel, SettingsTextInput, type ExtensionSettingsViewProps } from "@opencraft/extension-react";
import type { LightVelaAccountService } from "../account/lightvela-account-service";
import { LightVelaLoginOptions } from "../settings/lightvela-login-options";
import type { LightVelaEnvironmentService } from "./lightvela-environment-service";

export function createLightVelaEnvironmentView(account: LightVelaAccountService, service: LightVelaEnvironmentService) {
  return function LightVelaEnvironmentView({ host, onDismiss }: ExtensionSettingsViewProps) {
    const auth = useSyncExternalStore(account.subscribe, account.getSnapshot, account.getSnapshot);
    const state = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
    const [name, setName] = useState("云端环境");
    const [nameError, setNameError] = useState<string | null>(null);
    const id = useId();
    const submitted = useRef(false);
    const canCheck = auth.session.status === "authenticated";
    useEffect(() => { if (canCheck) void service.check(host); }, [canCheck, auth.authGeneration]);
    useEffect(() => {
      if (submitted.current && (state.phase === "creating" || state.phase === "complete")) onDismiss?.();
    }, [state.phase, onDismiss]);
    const busy = ["idle", "checking", "submitting", "creating"].includes(state.phase);
    const signedOut = auth.session.status === "anonymous";
    return <div className="environment-create-view"><SettingsPanel title="添加环境" footer={
      <>
        <SettingsButton type="button" onClick={onDismiss}>{state.request ? "关闭" : "取消"}</SettingsButton>
        {!signedOut && state.phase === "ready" ? <SettingsButton variant="primary" type="submit" form={id} disabled={!name.trim()}>添加</SettingsButton> : null}
        {!signedOut && ["error", "blocked", "waiting", "failed", "unknown"].includes(state.phase) ? <SettingsButton type="button" onClick={() => void service.check(host)}>重新检查</SettingsButton> : null}
        {!signedOut && state.websiteUrl ? <SettingsButton type="button" variant="primary" onClick={() => window.open(state.websiteUrl!, "_blank", "noopener,noreferrer")}>前往官网 ↗</SettingsButton> : null}
      </>
    }>
      {signedOut ? <LightVelaLoginOptions account={account} snapshot={auth} authentication={host.authentication} reason="environment-create" /> : <>
        <div className="environment-create-view__provider"><strong>LightVela</strong><span>{auth.region === "cn" ? "国内账号 · lightvela.com" : "国际账号 · lightvela.ai"}</span></div>
        {busy ? <div className="environment-create-view__status" role="status">{state.phase === "submitting" ? "正在提交创建请求…" : state.phase === "creating" ? "正在创建，可关闭窗口继续工作。" : "正在检查添加条件…"}</div> : null}
        {state.phase === "ready" ? <form id={id} onSubmit={event => {
          event.preventDefault(); setNameError(null); submitted.current = true;
          void service.create(name, host).catch(error => setNameError(error instanceof Error ? error.message : "名称无效"));
        }}>
          <label htmlFor={`${id}-name`}>环境名称</label>
          <SettingsTextInput id={`${id}-name`} value={name} maxLength={64} autoFocus required aria-invalid={!!nameError}
            aria-describedby={nameError ? `${id}-error` : undefined} onChange={event => setName(event.currentTarget.value)} />
          {nameError ? <div id={`${id}-error`} role="alert">{nameError}</div> : null}
        </form> : null}
        {!busy && state.message ? <SettingsNotice tone={state.phase === "error" || state.phase === "failed" ? "error" : "neutral"}>{state.message}</SettingsNotice> : null}
        {!busy && auth.phase === "error" ? <SettingsNotice tone="error">无法读取账号，请重新检查或重新登录。</SettingsNotice> : null}
      </>}
    </SettingsPanel></div>;
  };
}
