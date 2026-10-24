import { useEffect, useRef, useState } from "react";
import type { NativeSpeechPort, NativeSpeechInfo, NativeSpeechPreferences } from "@opencraft/app-host-protocol";
import { SettingsActions, SettingsButton, SettingsGroup, SettingsNotice, SettingsPageHeader, SettingsRow, SettingsSection, SettingsSelect } from "@opencraft/extension-react";

export function createVoiceSettingsView(port: NativeSpeechPort) {
  return function VoiceSettings() {
    const [preferences, setPreferences] = useState<NativeSpeechPreferences>({ deviceId: null, language: null });
    const [info, setInfo] = useState<NativeSpeechInfo | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(true);
    const generation = useRef(0), saving = useRef(false);
    const refresh = async () => {
      const epoch = ++generation.current; setBusy(true);
      try {
        const preference = await port.readPreferences();
        const result = await port.probe(preference.language ?? navigator.language);
        if (generation.current !== epoch) return;
        setPreferences(preference); setInfo(result); setError(null);
      } catch { if (generation.current === epoch) setError("无法读取系统语音设置，请重试"); }
      finally { if (generation.current === epoch) setBusy(false); }
    };
    useEffect(() => { void refresh(); return () => { generation.current++; }; }, [port]);
    const update = async (next: NativeSpeechPreferences) => {
      if (saving.current) return; saving.current = true; const epoch = ++generation.current; setBusy(true);
      try { await port.writePreferences(next); if (epoch === generation.current) await refresh(); }
      catch { if (epoch === generation.current) { setError("保存语音设置失败，请重试"); setBusy(false); } }
      finally { saving.current = false; }
    };
    const unavailable = preferences.deviceId !== null && info !== null && !info.devices.some(device => device.id === preferences.deviceId);
    return <>
      <SettingsPageHeader title="语音输入" description="使用 Mac 系统语音识别，不依赖聊天模型。" />
      <SettingsSection title="系统语音" action={<SettingsButton disabled={busy} onClick={() => { void refresh(); }}>刷新设备</SettingsButton>}>
        <SettingsGroup aria-busy={busy}>
          <SettingsRow label="输入设备" htmlFor="native-speech-device" description={unavailable ? "所选麦克风不可用，请重新选择；不会自动切换设备。" : "设备设置作用于当前客户端，下次录音时使用。"}>
            <SettingsSelect id="native-speech-device" value={preferences.deviceId ?? ""} disabled={busy} onChange={event => { void update({ ...preferences, deviceId: event.target.value || null }); }}>
              <option value="">系统默认</option>
              {unavailable ? <option value={preferences.deviceId!}>不可用的麦克风</option> : null}
              {info?.devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}
            </SettingsSelect>
          </SettingsRow>
          <SettingsRow label="识别语言" htmlFor="native-speech-language" description="默认跟随客户端语言，支持情况由系统报告。">
            <SettingsSelect id="native-speech-language" value={preferences.language ?? ""} disabled={busy} onChange={event => { void update({ ...preferences, language: event.target.value || null }); }}>
              <option value="">跟随客户端</option><option value="zh-CN">中文（普通话）</option><option value="en-US">English</option>
            </SettingsSelect>
          </SettingsRow>
          <SettingsRow label="识别方式" description="不承诺所有语言和设备均可离线。">
            {info === null ? "读取中…" : info.supportsOnDeviceRecognition ? "当前语言支持端侧识别，优先在设备上处理" : "当前语言不支持端侧识别，可能使用 Apple 语音服务"}
          </SettingsRow>
          <SettingsRow label="语音权限" description="只有启动语音输入时才申请语音识别和麦克风权限。">
            {info?.authorization === "authorized" ? "已授权" : info?.authorization === "denied" || info?.authorization === "restricted" ? "需在系统设置中允许" : "首次使用时由系统询问"}
          </SettingsRow>
        </SettingsGroup>
        {error ? <SettingsNotice tone="error" role="alert">{error}<SettingsActions><SettingsButton onClick={() => { void refresh(); }}>重试</SettingsButton></SettingsActions></SettingsNotice> : null}
      </SettingsSection>
    </>;
  };
}
