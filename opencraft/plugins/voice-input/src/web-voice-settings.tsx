import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SettingsButton, SettingsGroup, SettingsNotice, SettingsPageHeader, SettingsRow, SettingsSection, SettingsSelect } from "@opencraft/extension-react";
import type { SpeechServiceClient, VoiceInputPreference, VoiceProviderChoice } from "./cloud-speech";

export function createWebVoiceSettings(service: SpeechServiceClient, usePreferences: () => VoiceInputPreference) {
  return function WebVoiceSettings() {
    const preferences = usePreferences(), snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot);
    const [saving, setSaving] = useState(false), [error, setError] = useState(false);
    const alive = useRef(true);
    useEffect(() => { alive.current = true; void service.refresh(); return () => { alive.current = false; }; }, []);
    const selected = snapshot.selection ? JSON.stringify([snapshot.selection.providerId, snapshot.selection.modelId]) : "";
    const known = snapshot.models.some(model => JSON.stringify([model.providerId, model.modelId]) === selected);
    return <>
      <SettingsPageHeader title="语音输入" description="停止录音可写入文字，也可选择识别后发送。" />
      <SettingsSection title="识别服务" action={<SettingsButton disabled={snapshot.phase === "loading"} onClick={() => { void service.refresh(); }}>刷新</SettingsButton>}>
        <SettingsGroup>
          <SettingsRow label="识别方式" htmlFor="web-speech-provider" description="选择仅影响下次听写，不改变聊天模型。">
            <SettingsSelect id="web-speech-provider" value={preferences.provider} disabled={saving} onChange={event => {
              const value = event.target.value as VoiceProviderChoice; setError(false); setSaving(true);
              void preferences.setProvider(value).catch(() => { if (alive.current) setError(true); }).finally(() => { if (alive.current) setSaving(false); });
            }}>
              <option value="auto">自动选择</option><option value="hunyuan">混元语音</option><option value="system">浏览器语音</option>
            </SettingsSelect>
          </SettingsRow>
          <SettingsRow label="转写模型" htmlFor="web-speech-model" description="在模型服务中添加并启用混元语音连接，密钥沿用模型服务管理。">
            <SettingsSelect id="web-speech-model" value={selected} disabled={saving || snapshot.revision === null} onChange={event => {
              const ids: string[] | null = event.target.value ? JSON.parse(event.target.value) : null;
              setError(false); setSaving(true);
              void service.selectModel(ids ? { providerId: ids[0]!, modelId: ids[1]! } : null)
                .catch(() => { if (alive.current) setError(true); }).finally(() => { if (alive.current) setSaving(false); });
            }}>
              <option value="">未选择</option>
              {selected && !known ? <option value={selected} disabled>所选模型已不可用</option> : null}
              {snapshot.models.map(model => <option key={JSON.stringify([model.providerId, model.modelId])} value={JSON.stringify([model.providerId, model.modelId])} disabled={!model.enabled}>{model.name}{model.enabled ? "" : "（未启用）"}</option>)}
            </SettingsSelect>
          </SettingsRow>
          <SettingsRow label="混元语音" description="录音仅用于转写；服务密钥由服务器管理。">
            {snapshot.phase === "ready" ? "可用" : snapshot.phase === "loading" ? "检查中…" : "暂不可用"}
          </SettingsRow>
          <SettingsRow label="录音长度" description="一次最多两分钟。录音失败或取消时保留原有输入。">停止后完成识别</SettingsRow>
        </SettingsGroup>
        {error && <SettingsNotice tone="error">未能保存，请刷新后核对</SettingsNotice>}
      </SettingsSection>
    </>;
  };
}
