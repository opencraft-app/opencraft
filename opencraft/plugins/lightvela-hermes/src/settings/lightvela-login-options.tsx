import { Globe2 } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AuthenticationFlowPort, AuthenticationFlowRequest } from "@opencraft/workbench-runtime";

import {
  SettingsActions,
  SettingsButton,
  SettingsSegmented,
} from "@opencraft/extension-react";

import type { LightVelaAccountService, LightVelaAccountSnapshot } from "../account/lightvela-account-service";
import { selectLightVelaLoginRegion } from "./lightvela-region-selection";

const subscribeEmpty = () => () => undefined;
const readEmpty = () => null;

export function LightVelaLoginOptions({ account, snapshot, disabled = false, authentication, flowId, reason = "host-access" }: {
  account: LightVelaAccountService;
  snapshot: LightVelaAccountSnapshot;
  disabled?: boolean;
  authentication?: AuthenticationFlowPort;
  flowId?: string;
  reason?: AuthenticationFlowRequest["reason"];
}) {
  const isChina = snapshot.region === "cn";
  const [regionError, setRegionError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [legacyWaiting, setLegacyWaiting] = useState(false);
  const [owner] = useState(() => crypto.randomUUID());
  const ownedFlow = useRef<string | null>(null);
  const activeFlow = useSyncExternalStore(authentication?.subscribe ?? subscribeEmpty, authentication?.getSnapshot ?? readEmpty, readEmpty);
  const currentFlow = activeFlow?.id === (flowId ?? ownedFlow.current) ? activeFlow : null;
  const waiting = currentFlow?.phase === "pending" || legacyWaiting;
  useEffect(() => () => {
    // The shell owns a dedicated dialog lease; only inline feature leases retire with this View.
    if (ownedFlow.current) authentication?.abandon(ownedFlow.current);
  }, [authentication]);
  const signIn = async () => {
    setLoginError(null);
    if (authentication) {
      try {
        const id = flowId ?? authentication.open({ providerId: "lightvela.hermes.account", owner, reason, presentation: "inline" });
        if (!flowId) ownedFlow.current = id;
        await authentication.submit(id);
      } catch { setLoginError("登录未完成，请重试。"); }
      return;
    }
    // Compatibility for non-Workbench embeds; production shells always supply the Cordis capability.
    setLegacyWaiting(true);
    try { await account.signIn(); }
    catch { setLoginError("登录未完成，请重试。"); }
    finally { setLegacyWaiting(false); }
  };
  return (
    <div className="lightvela-login-options">
      <div className="lightvela-login-options__intro">
        <span className="lightvela-login-options__icon" aria-hidden="true"><Globe2 size={17} /></span>
        <div>
          <strong>选择登录站点</strong>
          <small>
            {isChina
              ? "国内账号由 lightvela.com 提供服务"
              : "国际账号由 lightvela.ai 提供服务"}
          </small>
        </div>
      </div>
      <div className="lightvela-login-options__controls">
        <SettingsSegmented
          label="登录站点"
          value={snapshot.region}
          disabled={disabled || waiting}
          options={[
            { value: "cn", label: "国内版" },
            { value: "intl", label: "国际版" },
          ]}
          onValueChange={(value) => setRegionError(selectLightVelaLoginRegion(account, value === "cn" ? "cn" : "intl"))}
        />
        {regionError === null ? null : <small role="alert">{regionError}</small>}
        <SettingsActions>
          <SettingsButton variant="primary" type="button" disabled={disabled || waiting} onClick={() => { void signIn(); }}>
            {waiting ? "等待浏览器登录…" : "继续登录"}
          </SettingsButton>
          {waiting ? <SettingsButton type="button" onClick={() => {
            if (authentication && currentFlow) authentication.cancel(currentFlow.id);
            else void account.cancelSignIn().catch(() => setLoginError("取消登录失败，请重试。"));
          }}>取消登录</SettingsButton> : null}
        </SettingsActions>
        {currentFlow?.error || loginError ? <small role="alert">{currentFlow?.error ?? loginError}</small> : null}
      </div>
    </div>
  );
}
