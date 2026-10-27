import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { SettingsButton, SettingsGroup, SettingsNotice, SettingsPageHeader, SettingsRow, SettingsSection, SettingsSelect } from "@opencraft/extension-react";
import type { SpeechServiceClient, VoiceInputPreference, VoiceProviderChoice } from "./cloud-speech";

export function createWebVoiceSettings(service: SpeechServiceClient, usePreferences: () => VoiceInputPreference) {
  return function WebVoiceSettings() {
    const intl = useIntl();
    const preferences = usePreferences(), snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot);
    const [saving, setSaving] = useState(false), [error, setError] = useState(false);
    const alive = useRef(true);
    useEffect(() => { alive.current = true; void service.refresh(); return () => { alive.current = false; }; }, []);
    const selected = snapshot.selection ? JSON.stringify([snapshot.selection.providerId, snapshot.selection.modelId]) : "";
    const known = snapshot.models.some(model => JSON.stringify([model.providerId, model.modelId]) === selected);
    const status = snapshot.phase === "ready"
      ? intl.formatMessage({ id: "settings.voice.web.status.available", defaultMessage: "Available" })
      : snapshot.phase === "loading"
        ? intl.formatMessage({ id: "settings.voice.web.status.checking", defaultMessage: "Checking…" })
        : intl.formatMessage({ id: "settings.voice.web.status.unavailable", defaultMessage: "Unavailable" });
    return <>
      <SettingsPageHeader
        title={intl.formatMessage({ id: "settings.contributions.voiceInput", defaultMessage: "Voice input" })}
        description={intl.formatMessage({ id: "settings.voice.web.description", defaultMessage: "Stop recording to insert text, or send it after recognition." })}
      />
      <SettingsSection
        title={intl.formatMessage({ id: "settings.voice.web.service", defaultMessage: "Recognition service" })}
        action={<SettingsButton disabled={snapshot.phase === "loading"} onClick={() => { void service.refresh(); }}>{intl.formatMessage({ id: "settings.voice.web.refresh", defaultMessage: "Refresh" })}</SettingsButton>}
      >
        <SettingsGroup>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.voice.web.method", defaultMessage: "Recognition method" })}
            htmlFor="web-speech-provider"
            description={intl.formatMessage({ id: "settings.voice.web.methodDescription", defaultMessage: "This choice applies only to the next dictation and does not change the chat model." })}
          >
            <SettingsSelect id="web-speech-provider" value={preferences.provider} disabled={saving} onChange={event => {
              const value = event.target.value as VoiceProviderChoice; setError(false); setSaving(true);
              void preferences.setProvider(value).catch(() => { if (alive.current) setError(true); }).finally(() => { if (alive.current) setSaving(false); });
            }}>
              <option value="auto">{intl.formatMessage({ id: "settings.voice.web.provider.auto", defaultMessage: "Automatic" })}</option>
              <option value="hunyuan">{intl.formatMessage({ id: "settings.voice.web.provider.hunyuan", defaultMessage: "Hunyuan Speech" })}</option>
              <option value="system">{intl.formatMessage({ id: "settings.voice.web.provider.browser", defaultMessage: "Browser speech" })}</option>
            </SettingsSelect>
          </SettingsRow>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.voice.web.model", defaultMessage: "Transcription model" })}
            htmlFor="web-speech-model"
            description={intl.formatMessage({ id: "settings.voice.web.modelDescription", defaultMessage: "Add and enable a Hunyuan Speech connection in Model services. Credentials stay with Model services." })}
          >
            <SettingsSelect id="web-speech-model" value={selected} disabled={saving || snapshot.revision === null} onChange={event => {
              const ids: string[] | null = event.target.value ? JSON.parse(event.target.value) : null;
              setError(false); setSaving(true);
              void service.selectModel(ids ? { providerId: ids[0]!, modelId: ids[1]! } : null)
                .catch(() => { if (alive.current) setError(true); }).finally(() => { if (alive.current) setSaving(false); });
            }}>
              <option value="">{intl.formatMessage({ id: "settings.voice.web.model.none", defaultMessage: "Not selected" })}</option>
              {selected && !known ? <option value={selected} disabled>{intl.formatMessage({ id: "settings.voice.web.model.unavailable", defaultMessage: "Selected model is no longer available" })}</option> : null}
              {snapshot.models.map(model => <option key={JSON.stringify([model.providerId, model.modelId])} value={JSON.stringify([model.providerId, model.modelId])} disabled={!model.enabled}>{model.name}{model.enabled ? "" : intl.formatMessage({ id: "settings.voice.web.model.disabled", defaultMessage: " (not enabled)" })}</option>)}
            </SettingsSelect>
          </SettingsRow>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.voice.web.provider.hunyuan", defaultMessage: "Hunyuan Speech" })}
            description={intl.formatMessage({ id: "settings.voice.web.hunyuanDescription", defaultMessage: "Recordings are used only for transcription. The service credential is managed by the server." })}
          >
            {status}
          </SettingsRow>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.voice.web.duration", defaultMessage: "Recording length" })}
            description={intl.formatMessage({ id: "settings.voice.web.durationDescription", defaultMessage: "Up to two minutes at a time. Failed or cancelled recordings keep the existing input." })}
          >
            {intl.formatMessage({ id: "settings.voice.web.durationValue", defaultMessage: "Recognition finishes after you stop" })}
          </SettingsRow>
        </SettingsGroup>
        {error && <SettingsNotice tone="error">{intl.formatMessage({ id: "settings.voice.web.saveError", defaultMessage: "Could not save. Refresh and check again." })}</SettingsNotice>}
      </SettingsSection>
    </>;
  };
}
