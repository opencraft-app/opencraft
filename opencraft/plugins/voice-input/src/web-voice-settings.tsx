import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SettingsButton, SettingsGroup, SettingsNotice, SettingsPageHeader, SettingsRow, SettingsSection, SettingsSelect } from "@opencraft/extension-react";
import type { SpeechServiceClient, VoiceInputPreference, VoiceProviderChoice } from "./cloud-speech";

export function createWebVoiceSettings(service: SpeechServiceClient, usePreferences: () => VoiceInputPreference) {
  return function WebVoiceSettings() {
    const preferences = usePreferences(), snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot);
    const [saving, setSaving] = useState(false), [error, setError] = useState(false);
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
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
          <SettingsRow label="混元语音" description="录音仅用于转写；服务密钥由服务器管理。">
            {snapshot.phase === "ready" ? "可用" : snapshot.phase === "loading" ? "检查中…" : "暂不可用"}
          </SettingsRow>
          <SettingsRow label="录音长度" description="一次最多两分钟。录音失败或取消时保留原有输入。">停止后完成识别</SettingsRow>
        </SettingsGroup>
        {error && <SettingsNotice tone="error">未能保存，请重试</SettingsNotice>}
      </SettingsSection>
    </>;
  };
}
