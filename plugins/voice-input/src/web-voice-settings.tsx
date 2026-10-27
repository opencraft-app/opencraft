import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { SettingsButton, SettingsChoiceSelect, SettingsGroup, SettingsNotice, SettingsPageHeader, SettingsRow, SettingsSection } from "@opencraft/extension-react";
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
    const methodLabel = intl.formatMessage({ id: "settings.voice.web.method", defaultMessage: "Recognition method" });
    const modelLabel = intl.formatMessage({ id: "settings.voice.web.model", defaultMessage: "Transcription model" });
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
            label={methodLabel}
            htmlFor="web-speech-provider"
            description={intl.formatMessage({ id: "settings.voice.web.methodDescription", defaultMessage: "This choice applies only to the next dictation and does not change the chat model." })}
          >
            <SettingsChoiceSelect<VoiceProviderChoice> id="web-speech-provider" label={methodLabel} value={preferences.provider} disabled={saving} onValueChange={value => {
              setError(false); setSaving(true);
              void preferences.setProvider(value).catch(() => { if (alive.current) setError(true); }).finally(() => { if (alive.current) setSaving(false); });
            }} options={[
              { value: "auto", label: intl.formatMessage({ id: "settings.voice.web.provider.auto", defaultMessage: "Automatic" }) },
              { value: "hunyuan", label: intl.formatMessage({ id: "settings.voice.web.provider.hunyuan", defaultMessage: "Hunyuan Speech" }) },
              { value: "system", label: intl.formatMessage({ id: "settings.voice.web.provider.browser", defaultMessage: "Browser speech" }) },
            ]} />
          </SettingsRow>
          <SettingsRow
            label={modelLabel}
            htmlFor="web-speech-model"
            description={intl.formatMessage({ id: "settings.voice.web.modelDescription", defaultMessage: "Add and enable a Hunyuan Speech connection in Model services. Credentials stay with Model services." })}
          >
            <SettingsChoiceSelect id="web-speech-model" label={modelLabel} value={selected} disabled={saving || snapshot.revision === null} onValueChange={value => {
              const ids: string[] | null = value ? JSON.parse(value) : null;
              setError(false); setSaving(true);
              void service.selectModel(ids ? { providerId: ids[0]!, modelId: ids[1]! } : null)
                .catch(() => { if (alive.current) setError(true); }).finally(() => { if (alive.current) setSaving(false); });
            }} options={[
              { value: "", label: intl.formatMessage({ id: "settings.voice.web.model.none", defaultMessage: "Not selected" }) },
              ...(selected && !known ? [{ value: selected, disabled: true, label: intl.formatMessage({ id: "settings.voice.web.model.unavailable", defaultMessage: "Selected model is no longer available" }) }] : []),
              ...snapshot.models.map(model => ({ value: JSON.stringify([model.providerId, model.modelId]), disabled: !model.enabled, label: model.name + (model.enabled ? "" : intl.formatMessage({ id: "settings.voice.web.model.disabled", defaultMessage: " (not enabled)" })) })),
            ]} />
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
