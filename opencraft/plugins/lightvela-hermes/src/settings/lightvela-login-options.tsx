import { Globe2 } from "lucide-react";
import { useState } from "react";

import {
  SettingsActions,
  SettingsButton,
  SettingsSegmented,
} from "@opencraft/extension-react";

import type { LightVelaAccountService, LightVelaAccountSnapshot } from "../account/lightvela-account-service";
import { selectLightVelaLoginRegion } from "./lightvela-region-selection";

export function LightVelaLoginOptions({ account, snapshot, disabled = false }: {
  account: LightVelaAccountService;
  snapshot: LightVelaAccountSnapshot;
  disabled?: boolean;
}) {
  const isChina = snapshot.region === "cn";
  const [regionError, setRegionError] = useState<string | null>(null);
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
          disabled={disabled}
          options={[
            { value: "cn", label: "国内版" },
            { value: "intl", label: "国际版" },
          ]}
          onValueChange={(value) => setRegionError(selectLightVelaLoginRegion(account, value === "cn" ? "cn" : "intl"))}
        />
        {regionError === null ? null : <small role="alert">{regionError}</small>}
        <SettingsActions>
          <SettingsButton variant="primary" type="button" disabled={disabled} onClick={() => account.signIn()}>
            继续登录
          </SettingsButton>
        </SettingsActions>
        <small>登录方式将在 LightVela 安全页面中选择。</small>
      </div>
    </div>
  );
}
