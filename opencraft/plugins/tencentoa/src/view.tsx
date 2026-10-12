import { useSyncExternalStore } from "react";
import { SettingsButton, SettingsGroup, SettingsNotice, SettingsPanel, SettingsRow, SettingsSection } from "@opencraft/extension-react";
import type { TencentOaController } from "./controller";

export function createEmployeeIdentityView(controller: TencentOaController) {
  return function EmployeeIdentityView() {
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    const identity = snapshot.identity;
    return <SettingsPanel title="员工身份">
      <SettingsSection title="当前登录" action={<SettingsButton disabled={snapshot.phase === "loading"} onClick={() => { void controller.refresh(); }}>刷新</SettingsButton>}>
        <SettingsGroup>
          <SettingsRow label="登录状态">{identity ? "已登录" : "未登录"}</SettingsRow>
          <SettingsRow label="员工账号">{identity?.loginName ?? "—"}</SettingsRow>
          <SettingsRow label="员工编号">{identity?.staffId ?? "—"}</SettingsRow>
        </SettingsGroup>
        {snapshot.phase === "error" ? <SettingsNotice tone="error">暂时无法确认员工身份，请重试</SettingsNotice>
          : !identity ? <SettingsNotice>暂未识别到员工身份，请刷新重试</SettingsNotice> : null}
      </SettingsSection>
    </SettingsPanel>;
  };
}
